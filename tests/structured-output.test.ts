import { afterEach, expect, it } from "vitest";
import { Connection } from "@muse-code/sdk";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { MuseHost } from "../src/host.js";
import { createMuseProvider } from "../src/provider.js";
import { publishRetryStatus, setRetryStatusListener } from "../src/retry-status.js";
import { openFixtureHost, fixtureState } from "./fixture-host.js";

class Frames {
  private queue: string[] = [];
  private waiters: Array<(v: IteratorResult<string>) => void> = [];
  private done = false;
  push(v: any) {
    const line = typeof v === "string" ? v : `${JSON.stringify(v)}\n`;
    const w = this.waiters.shift();
    w ? w({ value: line, done: false }) : this.queue.push(line);
  }
  end() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        this.queue.length
          ? Promise.resolve({ value: this.queue.shift()!, done: false })
          : this.done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise<IteratorResult<string>>((r) => this.waiters.push(r)),
    };
  }
}

function schemaWithEnums(propertyCount: number, valuesPerEnum: number) {
  const properties: Record<string, any> = {};
  for (let i = 0; i < propertyCount; i++) {
    properties[`q${i}`] = {
      type: "string",
      enum: Array.from({ length: valuesPerEnum }, (_, j) => `v${j}`),
    };
  }
  return {
    type: "object",
    properties: {
      value: {
        type: "object",
        properties,
        additionalProperties: false,
      },
    },
    required: ["value"],
    additionalProperties: false,
  };
}

const providers: any[] = [];
afterEach(async () => {
  setRetryStatusListener(undefined);
  for (const p of providers.splice(0)) await p.retireAll();
  fixtureState.opens = [];
  fixtureState.events = [];
});

it("refuses tool schemas over 3000 total enum values locally before spawning a host", async () => {
  let opened = 0;
  const provider = createMuseProvider({
    openHost: async (opts) => {
      opened++;
      return openFixtureHost(opts);
    },
  });
  providers.push(provider);
  provider.setSessionManager({
    getSessionId: () => "schema-enum-over",
    getSessionFile: () => "s.jsonl",
    getBranch: () => [],
    buildSessionProjection: () => ({ messages: [] }),
  } as any);

  // 601 properties x 5 enum values = 3005 > 3000 provider limit
  const bigTool = {
    name: "structured_output",
    description: "Structured output",
    parameters: schemaWithEnums(601, 5),
  };
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    { messages: [{ role: "user", content: "grade" }], tools: [bigTool] },
    {},
  ).result();
  expect(opened).toBe(0);
  expect(res.stopReason).toBe("error");
  expect(res.errorMessage).toContain("structured_output");
  expect(res.errorMessage).toContain("3005");
  expect(res.errorMessage).toContain("3000");
  expect(res.errorMessage).toMatch(/nothing was submitted/i);
  expect(isRetryableAssistantError(res)).toBe(false);
});

it("accepts a schema at exactly 3000 total enum values", async () => {
  let opened = 0;
  const provider = createMuseProvider({
    openHost: async (opts) => {
      opened++;
      return openFixtureHost(opts);
    },
  });
  providers.push(provider);
  provider.setSessionManager({
    getSessionId: () => "schema-enum-exact",
    getSessionFile: () => "s.jsonl",
    getBranch: () => [],
    buildSessionProjection: () => ({ messages: [] }),
  } as any);

  // 600 properties x 5 enum values = 3000 == limit (normal non-structured_output tool)
  const exactTool = {
    name: "lookup",
    description: "Lookup",
    parameters: schemaWithEnums(600, 5),
  };
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    { messages: [{ role: "user", content: "ok" }], tools: [exactTool] },
    {},
  ).result();
  expect(opened).toBe(1);
  expect(res.stopReason).toBe("stop");
});

it("fails honestly when final text arrives without calling declared structured_output, preserving the plain text", async () => {
  const provider = createMuseProvider({
    openHost: async (opts) => openFixtureHost(opts),
  });
  providers.push(provider);
  provider.setSessionManager({
    getSessionId: () => "structured-omitted",
    getSessionFile: () => "s.jsonl",
    getBranch: () => [],
    buildSessionProjection: () => ({ messages: [] }),
  } as any);

  const structuredTool = {
    name: "structured_output",
    description: "Structured output",
    parameters: {
      type: "object",
      properties: { value: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      required: ["value"],
    },
  };
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    { messages: [{ role: "user", content: "return verdict" }], tools: [structuredTool] },
    {},
  ).result();
  expect(res.stopReason).toBe("error");
  expect(res.errorMessage).toMatch(/without calling.*structured_output/i);
  expect(res.content.some((p: any) => p.type === "text" && p.text.includes("fixture answer"))).toBe(true);
  expect(isRetryableAssistantError(res)).toBe(false);
});

it("allows plain-text completion when structured_output was already satisfied in conversation history", async () => {
  const provider = createMuseProvider({
    openHost: async (opts) => openFixtureHost(opts),
  });
  providers.push(provider);
  provider.setSessionManager({
    getSessionId: () => "structured-satisfied",
    getSessionFile: () => "s.jsonl",
    getBranch: () => [],
    buildSessionProjection: () => ({ messages: [] }),
  } as any);

  const structuredTool = {
    name: "structured_output",
    description: "Structured output",
    parameters: {
      type: "object",
      properties: { value: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      required: ["value"],
    },
  };
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    {
      messages: [
        { role: "user", content: "return verdict" },
        { role: "assistant", content: [{ type: "toolCall", id: "so-1", name: "structured_output", arguments: { value: { ok: true } } }] },
        { role: "toolResult", toolCallId: "so-1", toolName: "structured_output", content: [{ type: "text", text: "captured" }], isError: false },
        { role: "user", content: "brief summary" },
      ],
      tools: [structuredTool],
    },
    {},
  ).result();
  expect(res.stopReason).toBe("stop");
});

it("never renders undefined or null in retry status and surfaces underlying retry/terminal cause", async () => {
  const statuses: Array<string | undefined> = [];
  setRetryStatusListener((s) => statuses.push(s));
  const owner = {};
  publishRetryStatus(owner, { nextAttempt: 2, maxAttempts: 5, retryDelayMs: 1000, errorKind: null, httpStatus: null, reason: "upstream stream reset" });
  expect(statuses.at(-1)).toBe("Muse retry 2/5 scheduled in 1000 ms (upstream stream reset)");
  expect(statuses.at(-1)).not.toContain("null");
  expect(statuses.at(-1)).not.toContain("undefined");

  publishRetryStatus(owner, { errorKind: undefined, httpStatus: null, error: { message: "gateway closed stream" } });
  expect(statuses.at(-1)).toContain("gateway closed stream");
  expect(statuses.at(-1)).not.toContain("null");
  expect(statuses.at(-1)).not.toContain("undefined");
  publishRetryStatus(owner);

  // Terminal failure with missing error.message falls back to params.reason or lastRetryCause
  const provider = createMuseProvider({
    openHost: async (opts) => {
      const incoming = new Frames();
      const notify = (method: string, params: any) =>
        incoming.push({ jsonrpc: "2.0", method, params: { sessionId: "rk-session", viewCursor: "1", sourceRange: {}, ...params } });
      const connection = new Connection({
        incoming,
        async write(line: string) {
          const f = JSON.parse(line);
          if (f.method === "session/start") incoming.push({ jsonrpc: "2.0", id: f.id, result: { session: { sessionId: "rk-session" }, viewCursor: "0" } });
          else if (f.method === "mcpServer/readInventory") incoming.push({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "method not found", data: { kind: "methodNotFound", retryable: false } } });
          else if (f.method === "turn/cancel") incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: f.params?.commandId, status: "accepted" } });
          else if (f.method === "turn/start") {
            const turnId = f.params.commandId;
            incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: turnId, status: "accepted", disposition: "started", startedNewTurn: true, turnId } });
            notify("turn/started", { commandId: turnId, turnId });
            queueMicrotask(() => {
              notify("turn/retryScheduled", { turnId, attempt: 1, nextAttempt: 2, maxAttempts: 2, retryDelayMs: 500, errorKind: null, httpStatus: null, reason: "upstream stream reset" });
              notify("turn/completed", { turnId, terminal: "failed" });
            });
          }
        },
        close() { incoming.end(); },
      });
      const host = new MuseHost(connection, { sessionDurability: "ephemeral", grantedCapabilities: ["sessionMcp"] } as any, { ...opts, echo: true });
      await host.open();
      return host;
    },
  });
  providers.push(provider);
  provider.setSessionManager({
    getSessionId: () => "retry-cause-fallback",
    getSessionFile: () => "s.jsonl",
    getBranch: () => [],
    buildSessionProjection: () => ({ messages: [] }),
  } as any);
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    { messages: [{ role: "user", content: "hi" }], tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } }] },
    {},
  ).result();
  expect(res.stopReason).toBe("error");
  expect(res.errorMessage).toContain("upstream stream reset");
  expect(res.errorMessage).not.toContain("undefined");
});
