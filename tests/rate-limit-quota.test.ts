import { afterEach, expect, it, vi } from "vitest";
import { Connection } from "@muse-code/sdk";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseHost } from "../src/host.js";
import { createMuseProvider } from "../src/provider.js";
import { quotaExhausted, setQuotaListener } from "../src/rate-limit.js";
import { flushMuseLedger, museLedgerPath } from "../src/request-ledger.js";
import { setRetryStatusListener } from "../src/retry-status.js";

class Frames {
  private queue: any[] = [];
  private waiters: Array<(v: IteratorResult<any>) => void> = [];
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
          ? Promise.resolve({ value: this.queue.shift(), done: false })
          : this.done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise<IteratorResult<any>>((r) => this.waiters.push(r)),
    };
  }
}

function makeWireHost(options: { usageRead?: any; live?: boolean; onStart?: (notify: (m: string, p: any) => void, turnId: string) => void } = {}) {
  const incoming = new Frames();
  const writes: any[] = [];
  const events: any[] = [];
  const notify = (method: string, params: any) =>
    incoming.push({ jsonrpc: "2.0", method, params: { sessionId: "rl-session", viewCursor: "1", sourceRange: {}, ...params } });
  const connection = new Connection({
    incoming,
    async write(line: string) {
      const f = JSON.parse(line);
      writes.push(f);
      if (f.method === "session/start") {
        incoming.push({ jsonrpc: "2.0", id: f.id, result: { session: { sessionId: "rl-session" }, viewCursor: "0" } });
      } else if (f.method === "mcpServer/readInventory") {
        incoming.push({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "method not found", data: { kind: "methodNotFound", retryable: false } } });
      } else if (f.method === "usage/read") {
        incoming.push({ jsonrpc: "2.0", id: f.id, result: options.usageRead ?? {} });
      } else if (f.method === "turn/cancel") {
        incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: f.params?.commandId, status: "accepted" } });
      } else if (f.method === "turn/start") {
        const turnId = f.params.commandId;
        incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: turnId, status: "accepted", disposition: "started", startedNewTurn: true, turnId } });
        notify("turn/started", { commandId: turnId, turnId });
        options.onStart?.(notify, turnId);
      }
    },
    close() { incoming.end(); },
  });
  const host = new MuseHost(
    connection,
    { sessionDurability: "ephemeral", grantedCapabilities: ["sessionMcp"] } as any,
    {
      cwd: process.cwd(),
      tools: ["lookup"],
      promptMode: "none",
      echo: !options.live,
      onEvent: (e) => events.push(e),
    },
  );
  return { host, writes, events, notify, connection };
}

const providers: any[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  setQuotaListener(undefined);
  setRetryStatusListener(undefined);
  for (const p of providers.splice(0)) await p.retireAll();
});

it("lets Muse Code retry transient 429 rate limits instead of fencing as quota exhaustion", async () => {
  const statuses: Array<string | undefined> = [];
  setRetryStatusListener((s) => statuses.push(s));
  const provider = createMuseProvider({
    openHost: async (opts) => {
      const incoming = new Frames();
      const notify = (method: string, params: any) =>
        incoming.push({ jsonrpc: "2.0", method, params: { sessionId: "rl-session", viewCursor: "1", sourceRange: {}, ...params } });
      const connection = new Connection({
        incoming,
        async write(line: string) {
          const f = JSON.parse(line);
          if (f.method === "session/start") incoming.push({ jsonrpc: "2.0", id: f.id, result: { session: { sessionId: "rl-session" }, viewCursor: "0" } });
          else if (f.method === "mcpServer/readInventory") incoming.push({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "method not found", data: { kind: "methodNotFound", retryable: false } } });
          else if (f.method === "usage/read") incoming.push({ jsonrpc: "2.0", id: f.id, result: {} });
          else if (f.method === "turn/cancel") incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: f.params?.commandId, status: "accepted" } });
          else if (f.method === "turn/start") {
            const turnId = f.params.commandId;
            incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: turnId, status: "accepted", disposition: "started", startedNewTurn: true, turnId } });
            notify("turn/started", { commandId: turnId, turnId });
            queueMicrotask(() => {
              notify("turn/retryScheduled", {
                turnId, attempt: 1, nextAttempt: 2, maxAttempts: 10,
                retryDelayMs: 1500, httpStatus: 429, errorKind: "rate_limited", system: "meta",
                reason: "temporary rate limit",
              });
              notify("turn/modelRetryScheduled", {
                turnId, attempt: 2, nextAttempt: 3, maxAttempts: 10,
                retryDelayMs: 3000, httpStatus: 429, errorKind: "rateLimit", system: "meta",
              });
              notify("item/completed", {item:{kind:"agentMessage",itemId:"t1",turnId,text:"RECOVERED_AFTER_429"}});
              notify("turn/completed", { turnId, terminal: "completed" });
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
  provider.setSessionManager({ getSessionId: () => "rl-retry-ok", getSessionFile: () => "s.jsonl", getBranch: () => [], buildSessionProjection: () => ({ messages: [] }) } as any);
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    { messages: [{ role: "user", content: "hi" }], tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } }] },
    {},
  ).result();
  expect(res.stopReason).toBe("stop");
  expect(res.content.map((p: any) => p.text).join("")).toBe("RECOVERED_AFTER_429");
  expect(statuses.some((s) => s?.includes("HTTP 429"))).toBe(true);
});

it("distinguishes exhausted temporary 429 from quota exhaustion when retries finish", async () => {
  const provider = createMuseProvider({
    openHost: async (opts) => {
      const incoming = new Frames();
      const notify = (method: string, params: any) =>
        incoming.push({ jsonrpc: "2.0", method, params: { sessionId: "rl-fail", viewCursor: "1", sourceRange: {}, ...params } });
      const connection = new Connection({
        incoming,
        async write(line: string) {
          const f = JSON.parse(line);
          if (f.method === "session/start") incoming.push({ jsonrpc: "2.0", id: f.id, result: { session: { sessionId: "rl-fail" }, viewCursor: "0" } });
          else if (f.method === "mcpServer/readInventory") incoming.push({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "method not found", data: { kind: "methodNotFound", retryable: false } } });
          else if (f.method === "turn/cancel") incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: f.params?.commandId, status: "accepted" } });
          else if (f.method === "turn/start") {
            const turnId = f.params.commandId;
            incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: turnId, status: "accepted", disposition: "started", startedNewTurn: true, turnId } });
            notify("turn/started", { commandId: turnId, turnId });
            queueMicrotask(() => {
              notify("turn/retryScheduled", { turnId, attempt: 1, nextAttempt: 2, maxAttempts: 2, retryDelayMs: 500, httpStatus: 429, errorKind: "rate_limited" });
              notify("turn/completed", { turnId, terminal: "failed", error: { kind: "modelError", message: "429 Too Many Requests (burst limit)", retryable: true } });
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
  provider.setSessionManager({ getSessionId: () => "rl-fail-sess", getSessionFile: () => "s.jsonl", getBranch: () => [], buildSessionProjection: () => ({ messages: [] }) } as any);
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    { messages: [{ role: "user", content: "hi" }], tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } }] },
    {},
  ).result();
  expect(res.stopReason).toBe("error");
  expect(res.errorMessage).toContain("HTTP 429");
  expect(res.errorMessage).toContain("Too Many Requests");
  expect(res.errorMessage).not.toMatch(/quota refused/i);
});

it.each([
  {
    name: "typed MSP QuotaDetail with resetsAtMs",
    error: {
      kind: "modelError",
      message: "429 Subscription quota exhausted. Your usage window resets at 2026-11-23T00:00:00Z. (rate_limit_error)",
      quota: { limitKind: "weekly", resetsAtMs: Date.parse("2026-11-23T00:00:00.000Z") },
      retryable: false,
    },
    expectReset: "2026-11-23T00:00:00.000Z",
    expectText: "Subscription quota exhausted",
  },
  {
    name: "provider quota-exhausted message without typed quota object",
    error: {
      kind: "rate_limit_error",
      httpStatus: 429,
      message: "429 Subscription quota exhausted. Your usage window resets at 2026-11-23T00:00:00Z. (rate_limit_error)",
      retryable: false,
    },
    expectReset: "2026-11-23T00:00:00Z",
    expectText: "Subscription quota exhausted",
  },
])("definitive quota exhaustion surfaces reset time and provider message without triggering Pi auto-retry: $name", async ({ error, expectReset, expectText }) => {
  const provider = createMuseProvider({
    openHost: async (opts) => {
      const incoming = new Frames();
      const notify = (method: string, params: any) =>
        incoming.push({ jsonrpc: "2.0", method, params: { sessionId: "rl-quota", viewCursor: "1", sourceRange: {}, ...params } });
      const connection = new Connection({
        incoming,
        async write(line: string) {
          const f = JSON.parse(line);
          if (f.method === "session/start") incoming.push({ jsonrpc: "2.0", id: f.id, result: { session: { sessionId: "rl-quota" }, viewCursor: "0" } });
          else if (f.method === "mcpServer/readInventory") incoming.push({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "method not found", data: { kind: "methodNotFound", retryable: false } } });
          else if (f.method === "turn/cancel") incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: f.params?.commandId, status: "accepted" } });
          else if (f.method === "turn/start") {
            const turnId = f.params.commandId;
            incoming.push({ jsonrpc: "2.0", id: f.id, result: { commandId: turnId, status: "accepted", disposition: "started", startedNewTurn: true, turnId } });
            notify("turn/started", { commandId: turnId, turnId });
            queueMicrotask(() => {
              notify("turn/completed", { turnId, terminal: "failed", error });
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
  provider.setSessionManager({ getSessionId: () => "rl-quota-sess", getSessionFile: () => "s.jsonl", getBranch: () => [], buildSessionProjection: () => ({ messages: [] }) } as any);
  const res = await provider.streamViaMuse(
    { id: "echo", provider: "pi-muse-tether" },
    { messages: [{ role: "user", content: "hi" }], tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } }] },
    {},
  ).result();
  expect(res.stopReason).toBe("error");
  expect(res.errorMessage).toMatch(/quota refused/i);
  expect(res.errorMessage).toContain(expectReset);
  expect(res.errorMessage).toContain(expectText);
  // Critical: Pi must not auto-retry a definitive quota exhaustion even when provider text says 429 / rate_limit_error.
  expect(isRetryableAssistantError(res)).toBe(false);
});

it("usage event carrying no data is never read as quota exhaustion or logged as an empty rate_limit row", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
  vi.stubEnv("XDG_STATE_HOME", await mkdtemp(join(tmpdir(), "muse-empty-usage-")));
  const published: any[] = [];
  setQuotaListener((p) => published.push(p));

  const emptyUsage = {
    observedAtMs: null,
    tier: null,
    window: { usedPercent: null, resetsAtMs: null, windowDurationMins: null },
    weekly: { usedPercent: null, resetsAtMs: null },
  };
  expect(quotaExhausted(undefined)).toBe(false);
  expect(quotaExhausted({})).toBe(false);
  expect(quotaExhausted(emptyUsage)).toBe(false);

  const wire = makeWireHost({ usageRead: { usage: emptyUsage }, live: true });
  try {
    await wire.host.open();
    wire.host.receive({ method: "usage/changed", params: emptyUsage });
    const ack = await wire.host.submitInput("hello");
    expect(ack.turnId).toBeTruthy();
    expect(wire.host.fencedReason).toBeUndefined();
    expect(published).toEqual([]);
    await flushMuseLedger();
    const rows = (await readFile(museLedgerPath(), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.type === "rate_limit")).toEqual([]);
  } finally {
    await wire.host.close();
  }
});

it("usage/read at 100% refuses before turn/start and surfaces reset time without Pi auto-retry", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
  const resetMs = Date.parse("2026-11-23T06:00:00.000Z");
  const wire = makeWireHost({
    live: true,
    usageRead: {
      usage: {
        observedAtMs: resetMs - 1000,
        tier: "pro",
        window: { usedPercent: 100, resetsAtMs: resetMs, windowDurationMins: 300 },
        weekly: { usedPercent: 40, resetsAtMs: resetMs + 86400000 },
      },
    },
  });
  try {
    await wire.host.open();
    const err = await wire.host.submitInput("never sent").catch((e: any) => e);
    expect(err.message).toMatch(/limit reached/);
    expect(err.message).toContain("2026-11-23T06:00:00.000Z");
    expect(wire.writes.some((w) => w.method === "turn/start")).toBe(false);
    expect(isRetryableAssistantError({ stopReason: "error", errorMessage: err.message } as any)).toBe(false);
  } finally {
    await wire.host.close();
  }
});
