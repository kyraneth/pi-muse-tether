import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Connection, Session, type DuplexTransport } from "@muse-code/sdk";
import { MuseHost, openMuseHost, museLaunchOptions,
  type MuseHostOptions, type MuseHostEvent, type MuseFrame } from "../src/host.ts";

// An inherited live opt-in must never turn an offline test into paid inference.
delete process.env.PI_MUSE_TETHER_LIVE;
type Wire = Record<string, any>;
const options = (extra: Partial<MuseHostOptions> = {}): MuseHostOptions => ({
  cwd: process.cwd(), tools: ["lookup"], promptMode: "none", echo: true, ...extra,
});
const initialized = { sessionDurability: "ephemeral", grantedCapabilities: ["sessionMcp","rawLog"] } as Parameters<typeof MuseHost["prototype"]["hostExited"]>[0] & any;

class Frames implements AsyncIterable<string> {
  #queued: IteratorResult<string>[] = [];
  #waiters: ((value: IteratorResult<string>) => void)[] = [];
  push(frame: Wire): void { this.#send({ value: JSON.stringify(frame) + "\n", done: false }); }
  end(): void { this.#send({ value: undefined, done: true }); }
  #send(value: IteratorResult<string>): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value); else this.#queued.push(value);
  }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return { next: () => Promise.resolve(this.#queued.shift() ?? new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve))) };
  }
}

function fixture(extra: Partial<MuseHostOptions> = {}, beforeOpen?: (f: ReturnType<typeof fixture>) => void, queued = false) {
  const incoming = new Frames();
  const writes: Wire[] = [];
  let turn = 0;
  let session!: Session;
  const waits: { predicate: (frame: Wire) => boolean; resolve: (frame: Wire) => void }[] = [];
  const reply = (request: Wire, result: Wire) => incoming.push({ jsonrpc: "2.0", id: request.id, result });
  const transport: DuplexTransport = {
    incoming,
    async write(chunk) {
      const frame = JSON.parse(chunk);
      writes.push(frame);
      for (const waiter of [...waits]) if (waiter.predicate(frame)) {
        waits.splice(waits.indexOf(waiter), 1); waiter.resolve(frame);
      }
      // Real 1.4.14 answers the 1.4.15 session-MCP inventory query methodNotFound.
      if (frame.method === "mcpServer/readInventory") { incoming.push({jsonrpc:"2.0",id:frame.id,error:{code:-32601,message:"method not found",data:{kind:"methodNotFound",retryable:false}}}); return; }
      if (frame.method === "session/start") {
        beforeOpen?.(result);
        reply(frame, { session: { sessionId: "server-session" }, viewCursor: "0" });
      } else if (frame.method === "turn/start") {
        turn++;
        const turnId = `turn-${turn}`;
        if (!queued) incoming.push({ jsonrpc: "2.0", method: "turn/started", params: {
          sessionId: "server-session", commandId: frame.params.commandId, turnId,
          viewCursor: String(turn), sourceRange: {},
        } });
        reply(frame, { commandId: frame.params.commandId, status: "accepted", disposition: queued ? "queued" : "started", startedNewTurn: !queued, turnId });
      } else if (frame.method === "log/streams") {
        reply(frame,{streams:[{stream:{kind:"session.live",id:"server-session"}}]});
      } else if (frame.method === "log/subscribe") {
        reply(frame,{subscriptionId:1});
      } else if (frame.method === "test/barrier") {
        reply(frame, {});
      } else if (frame.method === "approval/decide" || frame.method === "turn/cancel") {
        reply(frame, { commandId: frame.params.commandId, terminal: false, status: "accepted" });
      }
    },
    close() { incoming.end(); },
  };
  const connection = new Connection(transport);
  const events: MuseHostEvent[] = [];
  const host = new MuseHost(connection, initialized, options({ ...extra, onEvent: (event) => {
    events.push(event); extra.onEvent?.(event);
  } }), () => connection.close(), (opts) => (session = new Session(opts)));
  const result = { host, events, writes, incoming, connection, reply,
    get session() { return session; },
    waitWrite(predicate: (frame: Wire) => boolean): Promise<Wire> {
      const existing = writes.find(predicate);
      return existing ? Promise.resolve(existing) : new Promise((resolve) => waits.push({ predicate, resolve }));
    },
  };
  return result;
}

function approval(turnId: string, extra: Wire = {}): Wire {
  return { sessionId: "server-session", turnId, approvalId: "approval", toolCallId: "call-1",
    itemId: "item-1", taskId: "task-1", toolName: "mcp__pi__lookup", rawArgs: '{"key":"value"}',
    subject: { kind: "tool", toolName: "mcp__pi__lookup" },
    currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
    availableChoices: [
      { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once" },
      { choiceId: "persist", decision: "approvedForSession", scope: "session", label: "Always" },
      { choiceId: "deny-server-id", decision: "denied", scope: "once", label: "Deny" },
    ], sourceRange: {}, viewCursor: "10", judgeEscalated: false, protectedWrite: false, ...extra };
}
function frame(method: string, params: Wire = {}): MuseFrame {
  return { method, params: { sessionId: "server-session", sourceRange: {}, viewCursor: "20", ...params } };
}

// No process or filesystem side effect can precede these preflight refusals.
test("pre-spawn gates and immutable official launch recipe", async () => {
  await assert.rejects(openMuseHost(options({ tools: [], binary: "/does-not-exist" })), /tools-empty/);
  await assert.rejects(openMuseHost(options({ promptMode: "replace", binary: "/does-not-exist" })), /prompt mode/);
  await assert.rejects(openMuseHost(options({ promptMode: "append" })), /prompt mode/);
  await assert.rejects(openMuseHost(options({ echo: false, binary: "/does-not-exist" })), /PI_MUSE_TETHER_LIVE=1/);
  const launch = museLaunchOptions(options());
  assert.deepEqual(launch.args, ["serve", "--preset", "empty", "--no-session-log", "--contributor-mode", "on",
    "--config", 'run.toolset=["mcp__pi__lookup"]', "--disable-request-user-input", "--provider", "echo"]);
  assert.equal(launch.env?.MUSE_NO_AUTO_UPDATE, "1");
  assert.equal(launch.shutdownTimeoutMs, undefined, "SDK, not tether, owns its default deadline");
});

test("preflight capability refuses compaction and unsupported mode", () => {
  assert.throws(() => museLaunchOptions(options({ tools: [] })), /tools-empty/);
  assert.throws(() => museLaunchOptions(options({ promptMode: "replace" })), /prompt mode/);
});

test("pre-open server requests receipt immediately; ordered drain chooses server id", async () => {
  const f = fixture({}, (f) => {
    f.incoming.push({ jsonrpc: "2.0", id: 101, method: "approval/request", params: approval("early") });
    f.incoming.push({ jsonrpc: "2.0", method: "test/first", params: { sessionId: "server-session" } });
    f.incoming.push({ jsonrpc: "2.0", method: "test/foreign", params: { sessionId: "foreign-session" } });
    f.incoming.push({ jsonrpc: "2.0", method: "test/second", params: { sessionId: "server-session" } });
  });
  try {
    await f.host.open();
    const receipt = await f.waitWrite((w) => w.id === 101 && "result" in w);
    assert.deepEqual(receipt.result, {});
    const decide = await f.waitWrite((w) => w.method === "approval/decide");
    assert.equal(decide.params.choiceId, "deny-server-id");
    assert.deepEqual(f.events.filter((e) => e.kind === "frame").map((e) => e.frame.method),
      ["approval/request", "test/first", "test/second"]);
    f.incoming.push({ jsonrpc: "2.0", id: 102, method: "unknown/request", params: {} });
    const unknown = await f.waitWrite((w) => w.id === 102);
    assert.equal(unknown.error.code, -32601);
  } finally { await f.host.close(); }
});

test("approval only exact declared name + current turn/call/args validator + offered one-shot choice", async () => {
  const checked: Wire[] = [];
  const f = fixture({ validateApproval: (request) => {
    checked.push(request); return request.toolCallId === "call-1" && request.rawArgs === '{"key":"value"}';
  } });
  try {
    await f.host.open();
    const { turnId } = await f.host.submitInput("synthetic");
    for (const [index, change, expected] of [
      [0, {}, "allow_once"],
      [1, { toolName: "mcp__pi__lookup_extra", subject: { kind: "tool", toolName: "mcp__pi__lookup_extra" } }, "deny-server-id"],
      [2, { toolName: "bash", subject: { kind: "shell" } }, "deny-server-id"],
      [3, { turnId: "foreign-turn" }, "deny-server-id"],
      [4, { rawArgs: "not-json" }, "deny-server-id"],
      [5, { toolCallId: "different-call" }, "deny-server-id"],
      [6, { subagentOrigin: {} }, "deny-server-id"],
      [7, { availableChoices: [{ choiceId: "deny-server-id", decision: "denied", scope: "once" },
        { choiceId: "persist", decision: "approved", scope: "session" }] }, "deny-server-id"],
    ] as const) {
      const approvalId = `a-${index}`;
      const params = approval(turnId, { ...change, approvalId, currentRequirementId: { approvalId, sourceIndex: 0 } });
      // If the allow choice is not offered, implementation must deny, never invent it.
      f.incoming.push({ jsonrpc: "2.0", id: 200 + index, method: "approval/request", params });
      const decision = await f.waitWrite((w) => w.method === "approval/decide" && w.params.approvalId === approvalId);
      assert.equal(decision.params.choiceId, expected);
      assert.deepEqual(decision.params.requirementId, params.currentRequirementId);
    }
    assert.equal(checked.length, 2, "only scoped, parseable, declared Pi requests reach broker validator");
  } finally { await f.host.close(); }
});

test("refreshed requirements deduplicate per stage, never stale remembered requirement", async () => {
  const f = fixture({ validateApproval: () => true });
  try {
    await f.host.open();
    const { turnId } = await f.host.submitInput("synthetic");
    const first = approval(turnId);
    f.host.receive({ method: "approval/request", params: first });
    f.host.receive({ method: "approval/request", params: first });
    await f.waitWrite((w) => w.method === "approval/decide");
    const refreshed = approval(turnId, { currentRequirementId: { approvalId: "approval", sourceIndex: 1 } });
    f.host.receive({ method: "approval/request", params: refreshed });
    await f.waitWrite((w) => w.method === "approval/decide" && w.params.requirementId.sourceIndex === 1);
    assert.deepEqual(f.writes.filter((w) => w.method === "approval/decide").map((w) => w.params.requirementId.sourceIndex), [0, 1]);
  } finally { await f.host.close(); }
});

test("foreground is nonterminal, actual native usage retained, completed permits append without replay", async () => {
  const f = fixture();
  try {
    await f.host.open();
    const { turnId } = await f.host.submitInput("synthetic one");
    f.host.receive(frame("turn/foregroundCompleted", { turnId, blockingAgents: [] }));
    await assert.rejects(f.host.submitInput("must not append"), /no turn\/completed/);
    assert.equal(f.events.filter((e) => e.kind === "terminal").length, 0);
    const usage = { inputTokens: 13, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 0 };
    f.host.receive(frame("turn/completed", { turnId, terminal: "completed", usage }));
    const terminal = f.events.find((e) => e.kind === "terminal");
    assert.deepEqual(terminal?.frame.params?.usage, usage);
    await f.host.submitInput("synthetic two");
    assert.equal(f.session.pending.size, 0);
    assert.equal(f.writes.filter((w) => w.method === "turn/start").length, 2);
  } finally { await f.host.close(); }
});

test("child, blocking agents, view gaps, native tools and user questions fence before reuse", async () => {
  for (const bad of [
    frame("turn/foregroundCompleted", { blockingAgents: ["child"] }),
    ...["reminderChild", "subagent", "workflow", "userShell"].map((kind) => frame("item/started", { item: { kind } })),
    frame("view/gap"),
    frame("item/started", { item: { kind: "toolCall", toolName: "bash" } }),
    frame("userInput/requested", { userInputId: "question", questions: [] }),
  ]) {
    const f = fixture();
    try {
      await f.host.open();
      const { turnId } = await f.host.submitInput("synthetic");
      f.host.receive(bad);
      assert.ok(f.host.fencedReason, bad.method);
      f.host.receive(frame("turn/completed", { turnId, terminal: "completed" }));
      await assert.rejects(f.host.submitInput("forbidden"));
      assert.equal(f.events.filter((e) => e.kind === "terminal").length, 0);
      assert.equal(f.writes.filter((w) => w.method === "turn/start").length, 1);
      assert.equal(f.writes.filter((w) => w.method === "view/page").length, 0);
    } finally { await f.host.close(); }
  }
});

test("native MCP tool item uses the real tool field", async () => {
  const f = fixture();
  try {
    await f.host.open();
    const {turnId} = await f.host.submitInput("synthetic");
    f.host.receive(frame("item/completed", { item: { kind: "toolCall", tool: "mcp__pi__lookup", itemId: "item", turnId, revision: 2, status: "completed", callId: "call", visibleOutput: "synthetic" } }));
    assert.equal(f.host.fencedReason, undefined);
  } finally { await f.host.close(); }
});

test("mistaken pending enrollment retired BEFORE queue movement can replay", async () => {
  const f = fixture();
  try {
    await f.host.open();
    await f.host.submitInput("synthetic");
    f.session.pending.submitted({ commandId: "mistaken", input: [], anchorAfterItemId: null });
    f.session.pending.acked("mistaken", { turnId: "queued", disposition: "queued" });
    f.host.receive(frame("turn/started", { turnId: "other", commandId: "other" }));
    assert.match(f.host.fencedReason!, /pending/);
    assert.equal(f.session.pending.size, 0);
    assert.equal(f.writes.filter((w) => w.method === "turn/start").length, 1);
  } finally { await f.host.close(); }
});

test("unexpected EOF and death discharge ephemeral lineage; orderly EOF suppressed", async () => {
  const f = fixture();
  await f.host.open();
  await f.host.submitInput("synthetic");
  f.incoming.end();
  await f.connection.closed;
  assert.match(f.host.fencedReason!, /host died/);
  f.host.hostExited({ kind: "crash", exitCode: 1, exitSignal: null, stderrTail: [] });
  await assert.rejects(f.host.submitInput("never replay"));
  assert.equal(f.session.pending.size, 0);
  assert.equal(f.writes.filter((w) => w.method === "turn/start").length, 1);
  const g = fixture();
  await g.host.open(); await g.host.close();
  assert.equal(g.host.fencedReason, undefined);
});

// Real official client, no network model, no credentials: host creates a fresh
// HOME/XDG config/data/cache/state and launches only --provider echo.
for (const contributorMode of ["on", "off"] as const) test(`real official echo transport; ${contributorMode} argv + isolated credential home + native terminal`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-launch-test-"));
  const binary = process.env.PI_MUSE_TETHER_BINARY ?? join(homedir(), ".local/bin/muse");
  const wrapper = join(dir, "official-muse-wrapper");
  const evidence = join(dir, "launch.json");
  await writeFile(wrapper, `#!/usr/bin/env python3\nimport os,sys,json\nwith open(${JSON.stringify(evidence)},'w') as f: json.dump({'argv':sys.argv[1:],'config':os.environ.get('XDG_CONFIG_HOME'),'home':os.environ.get('HOME'),'auto':os.environ.get('MUSE_NO_AUTO_UPDATE')},f)\nos.execv(${JSON.stringify(binary)},[${JSON.stringify(binary)}]+sys.argv[1:])\n`, { mode: 0o700 });
  const events: MuseHostEvent[] = [];
  let settle!: (event: MuseHostEvent) => void;
  const terminal = new Promise<MuseHostEvent>((resolve) => { settle = resolve; });
  let host: MuseHost | undefined;
  try {
    host = await openMuseHost(options({ binary: wrapper, contributorMode, onEvent: (event) => {
      events.push(event); if (event.kind === "terminal" || event.kind === "fenced") settle(event);
    } }));
    await host.submitInput("OFFLINE_ECHO_SYNTHETIC");
    const end = await terminal;
    assert.equal(end.kind, "terminal", JSON.stringify(events));
    if (end.kind === "terminal") assert.equal(end.status, "completed", JSON.stringify(end.frame));
    assert.ok(events.some((e) => e.kind === "frame" && e.frame.method === "item/delta"), JSON.stringify(events));
    const launched = JSON.parse(await readFile(evidence, "utf8"));
    assert.deepEqual(launched.argv, ["serve", "--preset", "empty", "--no-session-log", "--contributor-mode", contributorMode, "--config", 'run.toolset=["mcp__pi__lookup"]', "--disable-request-user-input", "--provider", "echo"], "actual child argv must contain selected contributor-mode and exact Pi-only toolset");
    assert.notEqual(launched.home, homedir());
    assert.equal(launched.config, join(launched.home, "config"));
    assert.equal(launched.auto, "1");
    // Echo may omit token counters. Never synthesize zero usage.
    console.log("real echo terminal:", JSON.stringify(end));
  } finally { await host?.close(); await rm(dir, { recursive: true, force: true }); }
});

// Recorded long-history wire: completed at :08, queued ack, same command started at :09.
for (const outcome of ["own-start", "foreign-start", "death", "session-close", "close"] as const) {
  test(`queued admission waits for its own started event; ${outcome}`, async () => {
    const f = fixture({}, undefined, true);
    try {
      await f.host.open();
      let settled = false;
      const result = f.host.submitInput("synthetic queued").then(value => { settled = true; return {value}; }, error => { settled = true; return {error}; });
      const request = await f.waitWrite(w => w.method === "turn/start");
      await f.connection.request("test/barrier", {});
      assert.equal(settled, false, "queued acknowledgement cannot satisfy admission");
      if (outcome === "own-start" || outcome === "foreign-start")
        f.host.receive(frame("turn/started", {commandId:outcome === "own-start" ? request.params.commandId : "foreign",turnId:"turn-1"}));
      else if (outcome === "death") f.host.hostExited({kind:"transportEof"});
      else if (outcome === "session-close") f.host.receive(frame("session/closed",{reason:"hostShutdown"}));
      else await f.host.close();
      const response = await result;
      if (outcome === "own-start") assert.equal((response as any).value.turnId,"turn-1");
      else assert.ok((response as any).error,"foreign start/close/death must reject without resend");
      assert.equal(f.writes.filter(w=>w.method === "turn/start").length,1);
      assert.equal(f.session.pending.size,0);
    } finally { await f.host.close(); }
  });
}

test("pinned official echo client grants rawLog and opens its session subscription without inference", async()=>{
  const host=await openMuseHost(options({toolBatches:true}));
  try { assert.equal(host.batches,true); } finally {await host.close();}
});

test("fixture wire retry and recommitted batch retain one dispatch before and after completion", async () => {
  const wire=JSON.parse(readFileSync(new URL("./fixtures/vendor-retry.json",import.meta.url),"utf8"));
  const f=fixture({tools:["read"],toolBatches:true});
  try {
    await f.host.open();const {turnId}=await f.host.submitInput("offline replay");
    const batch=structuredClone(wire.batch);batch.params.record.payload.run_id=turnId;
    f.host.receive(batch);f.host.receive({...wire.retry,params:{...wire.retry.params,sessionId:"server-session",turnId}});
    f.host.receive(batch);
    assert.equal(f.host.fencedReason,undefined);
    assert.equal(f.events.filter(e=>e.kind==="tool-batch").length,1);
    assert.deepEqual((f.events.find(e=>e.kind==="tool-batch") as any).calls.map((c:any)=>c.callId),wire.batch.params.record.payload.event.tool_calls.map((c:any)=>c.call_id));
    f.host.receive(frame("turn/completed",{turnId,terminal:"completed"}));
    f.host.receive(batch); // Late recommit after terminal is fenced, never dispatched.
    assert.equal(f.events.filter(e=>e.kind==="tool-batch").length,1);
    assert.equal(f.writes.filter(w=>w.method==="turn/start").length,1);
  } finally {await f.host.close();}
});

test("Spark 1.2 catalogue effort guard refuses unsupported turns before submission, including max on a later turn", async () => {
  const catalog = JSON.parse(readFileSync(new URL("./fixtures/provider-catalog-window.json", import.meta.url), "utf8"));
  const row = catalog.models.find((m: any) => m.modelId === "muse-spark-1.2");
  const f = fixture({model:row.modelId, catalogueEfforts:row.variants});
  try {
    await f.host.open();
    await assert.rejects(f.host.submitInput("unsupported off", "none"), /absent from official model\/list/);
    assert.equal(f.writes.filter(w=>w.method === "turn/start").length,0);
    const {turnId} = await f.host.submitInput("supported", "high");
    f.host.receive(frame("turn/completed", {turnId,terminal:"completed"}));
    await assert.rejects(f.host.submitInput("unsupported continuation", "max"), /absent from official model\/list/);
    assert.equal(f.writes.filter(w=>w.method === "turn/start").length,1);
  } finally {await f.host.close();}
});

// The policy latch is process-wide and intentionally cannot be reset.
test("actual status denial is nonretryable, identifier containing 403 is harmless", async () => {
  const f = fixture();
  try {
    await f.host.open();
    const { turnId } = await f.host.submitInput("synthetic");
    f.host.receive(frame("provider/opaque403", { providerId: "opaque403" }));
    assert.equal(f.host.fencedReason, undefined);
    f.host.receive(frame("turn/completed", { turnId, terminal: "failed", error: { status: 403, message: "denied" } }));
    assert.match(f.host.fencedReason!, /nonretryable/);
    assert.ok(f.events.some((e) => e.kind === "frame" && e.frame.params?.error), "full native terminal error retained");
    await assert.rejects(f.host.submitInput("never replay"));
  } finally { await f.host.close(); }
});

