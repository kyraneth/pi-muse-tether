import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "typebox";

const control = vi.hoisted(() => ({
  stale: false,
  two: false,
  openGate: undefined as Promise<void> | undefined,
  openEntered: undefined as (() => void) | undefined,
  submitGate: undefined as Promise<void> | undefined,
  submitEntered: undefined as (() => void) | undefined,
  submitted: 0,
  closed: undefined as (() => void) | undefined,
}));
vi.mock("../src/host.js", () => ({
  openMuseHost: async (opts: any) => {
    control.openEntered?.();
    if (control.openGate) await control.openGate;
    let child: any;
    const approval = (id: string, index = 0) => ({
      toolName: "mcp__pi__lookup",
      toolCallId: id,
      rawArgs: '{"key":"a"}',
      approvalId: `approval-${id}`,
      currentRequirementId: {
        approvalId: `approval-${id}`,
        sourceIndex: index,
      },
    });
    return {
      async submitInput() {
        control.submitted++;
        control.submitEntered?.();
        if (control.submitGate) await control.submitGate;
        if (opts.signal?.aborted) throw new Error("closed during admission");
        const a = approval("vendor-call");
        if (!opts.validateApproval(a))
          throw new Error("fixture approval denied");
        if (control.stale)
          opts.onEvent({
            kind: "frame",
            frame: {
              method: "approval/request",
              params: {
                ...a,
                currentRequirementId: {
                  approvalId: a.approvalId,
                  sourceIndex: 1,
                },
                rawArgs: '{"key":"b"}',
              },
            },
          });
        const d = opts.mcpServers.pi;
        child = spawn(d.command, d.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...d.env },
        });
        const send = (id: number, callId: string) =>
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: {
                name: "lookup",
                arguments: { key: "a" },
                _meta: { callId },
              },
            }) + "\n",
          );
        createInterface({ input: child.stdout }).on("line", (line) => {
          const frame = JSON.parse(line);
          if (frame.error || frame.result?.content?.[0]?.text !== "from Pi")
            return;
          const callId = frame.id === 1 ? "vendor-call" : "vendor-call-2";
          opts.onEvent({
            kind: "frame",
            frame: {
              method: "item/completed",
              params: {
                item: { kind: "toolCall", tool: "mcp__pi__lookup", callId, status: "completed", visibleOutput: "from Pi" },
              },
            },
          });
          const usage = {
            kind: "frame",
            frame: {
              method: "session/tokenUsage",
              params: {
                sourceRange: { last: { id: `usage-${frame.id}` } },
                usage: {
                  inputTokens: 100,
                  outputTokens: 2,
                  cacheReadTokens: 70,
                },
                totalTokens: 102,
              },
            },
          };
          opts.onEvent(usage);
          opts.onEvent(usage);
          opts.onEvent({
            kind: "frame",
            frame: {
              method: "session/tokenUsage",
              params: {
                sourceRange: { last: { id: `second-usage-${frame.id}` } },
                usage: { inputTokens: 20, outputTokens: 1, cacheReadTokens: 7 },
                totalTokens: 21,
              },
            },
          });
          if (frame.id === 1 && control.two) {
            if (!opts.validateApproval(approval("vendor-call-2")))
              throw new Error("second approval denied");
            send(2, "vendor-call-2");
          } else
            opts.onEvent({
              kind: "terminal",
              status: "completed",
              turnId: "turn",
            });
        });
        send(1, "vendor-call");
        return { turnId: "turn", commandId: "command" };
      },
      async close() {
        if (child) {
          child.stdin.end();
          child.kill();
        }
        control.closed?.();
      },
      async cancelTurn() {},
      fence() {},
    };
  },
}));
import {
  streamViaMuse,
  setSessionManager,
  retireAll,
} from "../src/provider.js";
const model = { id: "echo", provider: "pi-muse-tether" },
  tools = [
    {
      name: "lookup",
      description: "synthetic",
      parameters: Type.Object({ key: Type.String() }),
    },
  ];
const user = { role: "user", content: "synthetic" };
function resultFor(call: any) {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: "lookup",
    content: [{ type: "text", text: "from Pi" }],
    isError: false,
    timestamp: Date.now(),
  };
}
afterEach(async () => {
  await retireAll();
  control.stale = false;
  control.two = false;
  control.openGate = undefined;
  control.openEntered = undefined;
  control.submitGate = undefined;
  control.submitEntered = undefined;
  control.submitted = 0;
  control.closed = undefined;
});
describe("Muse broker provider recorded fixture", () => {
  it("surfaces approved MCP call to Pi and resolves it only from the journaled Pi result", async () => {
    let entries: any[] = [];
    setSessionManager({
      getSessionId: () => "fixture-session",
      getBranch: () => entries,
    });
    const first = await streamViaMuse(
      model,
      { messages: [user], tools },
      {},
    ).result();
    expect(first.stopReason).toBe("toolUse");
    const call = first.content.find((x: any) => x.type === "toolCall") as any;
    expect(call.name).toBe("lookup");
    expect(call.arguments).toEqual({ key: "a" });
    const result = resultFor(call);
    entries = [{ id: "journal-entry", type: "message", message: result }];
    const final = await streamViaMuse(
      model,
      { messages: [user, first, result], tools },
      {},
    ).result();
    expect(final.stopReason).toBe("stop");
    expect(final.usage.input).toBe(43);
    expect(final.usage.output).toBe(3);
    expect(final.usage.cacheRead).toBe(77);
    expect(final.usage.totalTokens).toBe(21);
    expect((final as any).nativeUsage).toHaveLength(2);
  });
  it("refuses an unjournaled result and settles the current Pi request", async () => {
    setSessionManager({
      getSessionId: () => "missing-journal",
      getBranch: () => [],
    });
    const first = await streamViaMuse(
      model,
      { messages: [user], tools },
      {},
    ).result();
    const call = first.content.find((x: any) => x.type === "toolCall") as any;
    const final = await streamViaMuse(
      model,
      { messages: [user, first, resultFor(call)], tools },
      {},
    ).result();
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/journaled result unavailable/);
  });
  it("invalidates an earlier approval when a refreshed requirement changes arguments", async () => {
    control.stale = true;
    setSessionManager({
      getSessionId: () => "stale-approval",
      getBranch: () => [],
    });
    const result = await streamViaMuse(
      model,
      { messages: [user], tools },
      {},
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.content.some((x: any) => x.type === "toolCall")).toBe(false);
  });
  it("keeps two sequential MCP calls in the same host and journals each", async () => {
    control.two = true;
    let entries: any[] = [];
    setSessionManager({
      getSessionId: () => "two-calls",
      getBranch: () => entries,
    });
    const first = await streamViaMuse(
      model,
      { messages: [user], tools },
      {},
    ).result();
    const call1 = first.content.find((x: any) => x.type === "toolCall") as any;
    const r1 = resultFor(call1);
    entries.push({ id: "journal-1", type: "message", message: r1 });
    const second = await streamViaMuse(
      model,
      { messages: [user, first, r1], tools },
      {},
    ).result();
    expect(second.stopReason).toBe("toolUse");
    const call2 = second.content.find((x: any) => x.type === "toolCall") as any;
    expect(call2.id).not.toBe(call1.id);
    const r2 = resultFor(call2);
    entries.push({ id: "journal-2", type: "message", message: r2 });
    const final = await streamViaMuse(
      model,
      { messages: [user, first, r1, second, r2], tools },
      {},
    ).result();
    expect(final.stopReason).toBe("stop");
    expect(control.submitted).toBe(1);
  });
  it("settles retirement during host opening and closes the late host without submitting", async () => {
    let release!: () => void;
    control.openGate = new Promise<void>((r) => {
      release = r;
    });
    let closed!: () => void;
    const closedPromise = new Promise<void>((r) => {
      closed = r;
    });
    control.closed = closed;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    control.openEntered = entered;
    setSessionManager({ getSessionId: () => "opening", getBranch: () => [] });
    const running = streamViaMuse(
      model,
      { messages: [user], tools },
      {},
    ).result();
    await enteredPromise;
    const retiring=retireAll();
    const result = await running;
    expect(result.stopReason).toBe("aborted");
    release();
    await Promise.all([retiring,closedPromise]);
    expect(control.submitted).toBe(0);
  });
  it("settles abort during turn admission without accepting a later successful turn", async () => {
    let release!: () => void;
    control.submitGate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    control.submitEntered = entered;
    setSessionManager({
      getSessionId: () => "abort-admission",
      getBranch: () => [],
    });
    const signal = new AbortController();
    const running = streamViaMuse(
      model,
      { messages: [user], tools },
      { signal: signal.signal },
    ).result();
    await enteredPromise;
    signal.abort();
    const result = await running;
    expect(result.stopReason).toBe("aborted");
    release();
  });
  it("honors abort on a Pi tool-result continuation", async () => {
    let entries: any[] = [];
    setSessionManager({
      getSessionId: () => "abort-continuation",
      getBranch: () => entries,
    });
    const first = await streamViaMuse(
      model,
      { messages: [user], tools },
      {},
    ).result();
    const call = first.content.find((x: any) => x.type === "toolCall") as any;
    const r = resultFor(call);
    entries = [{ id: "journal-entry", type: "message", message: r }];
    const signal = new AbortController();
    const running = streamViaMuse(
      model,
      { messages: [user, first, r], tools },
      { signal: signal.signal },
    ).result();
    signal.abort();
    expect((await running).stopReason).toBe("aborted");
  });
  it("retires the parked host for an already-aborted continuation", async () => {
    let entries: any[] = [];
    setSessionManager({
      getSessionId: () => "already-aborted",
      getBranch: () => entries,
    });
    const first = await streamViaMuse(
      model,
      { messages: [user], tools },
      {},
    ).result();
    const call = first.content.find((x: any) => x.type === "toolCall") as any;
    const r = resultFor(call);
    entries = [{ id: "journal-entry", type: "message", message: r }];
    let closed = false;
    control.closed = () => {
      closed = true;
    };
    const signal = new AbortController();
    signal.abort();
    const result = await streamViaMuse(
      model,
      { messages: [user, first, r], tools },
      { signal: signal.signal },
    ).result();
    expect(result.stopReason).toBe("aborted");
    expect(closed).toBe(true);
  });
  it("settles an abort before host opening completes", async () => {
    let release!: () => void;
    control.openGate = new Promise<void>((r) => {
      release = r;
    });
    let closed!: () => void;
    const closedPromise = new Promise<void>((r) => {
      closed = r;
    });
    control.closed = closed;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    control.openEntered = entered;
    setSessionManager({
      getSessionId: () => "abort-opening",
      getBranch: () => [],
    });
    const signal = new AbortController();
    const running = streamViaMuse(
      model,
      { messages: [user], tools },
      { signal: signal.signal },
    ).result();
    await enteredPromise;
    signal.abort();
    const result = await running;
    expect(result.stopReason).toBe("aborted");
    release();
    await closedPromise;
    expect(control.submitted).toBe(0);
  });
});
