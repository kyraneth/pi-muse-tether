import {refusal} from "./live-safety.mjs";
import { redPng, answerFailure } from "./verification-support.js";
import {writeFileSync,existsSync,watch} from "node:fs";
import { assertOfflineModel } from "../tests/verification-offline-guard.js";
/** ROOT ONLY. No inference occurs without --live. Synthetic contributor mode only.
 * One Pi candidate process, serial prompts; official usage/read quota before/after.
 * Optional --cache-probe parks between increasing, measured idle gaps until stopped.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawnMspConnection } from "@muse-code/sdk";
import { museLaunchOptions } from "../src/host.js";
import { qualifyMuseVersion } from "../src/cli-version.js";
import { quotaPayload, quotaExhausted } from "../src/rate-limit.js";
import { museDoctor } from "../src/doctor.js";
const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const imageOnly = argv.includes("--image-only");
if (imageOnly && argv.includes("--cache-probe")) throw new Error("Image-only excludes cache stages");
if (!offline && !argv.includes("--live"))
  throw new Error(
    "ROOT live authorization required: --live <new-absolute-output-dir> [--cache-probe]; not run by offline tests",
  );
const out = argv.find((a) => a.startsWith("/"));
if (!out) throw new Error("Provide a new absolute output directory");
// Exclusive directory is the one-candidate lock. No automatic retry or cleanup.
await mkdir(out, { mode: 0o700 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { META_API_KEY: _, ...inherited } = process.env;
const env: NodeJS.ProcessEnv = {
  ...inherited,
  VERIFICATION_ENTRY_LOG: join(out, "entry-wire.jsonl"),
  PI_MUSE_TETHER_LIVE: offline ? "0" : "1",
  MUSE_NO_AUTO_UPDATE: "1",
  XDG_STATE_HOME: join(out, "state"),
  PI_CODING_AGENT_DIR: join(out, "pi-agent"),
};
process.env.PI_MUSE_TETHER_LIVE = offline ? "0" : "1";
process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
delete process.env.META_API_KEY;
// Offline runs structurally refuse builtin transports AND preload a network
// backstop into the native Pi child. A future fixture regression cannot send HTTP.
if (offline) {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${join(root, "tests/verification-no-network.mjs")}`;
  env.VERIFICATION_NETWORK_ATTEMPTS = join(out, "network-attempts.log");
}
const telemetry = join(out, "telemetry.jsonl");
const log = async (row: any) =>
  appendFile(
    telemetry,
    JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n",
  );
function denied(value: any): boolean {
 const hit=refusal(value);
 if(hit && !offline && process.env.BENCH_STOP_FILE) {
  try { writeFileSync(process.env.BENCH_STOP_FILE,JSON.stringify({reason:hit,noReplay:true}),{flag:"wx"}); } catch(e:any) { if(e.code!=="EEXIST")throw e; }
 }
 return !!hit;
}
let forbidden = false;
const proofFailures: { label: string; reason: string }[] = [];
async function quota(label: string) {
  if (offline) {
    const payload = {
      source: "synthetic-offline-no-account-read",
      window: { usedPercent: 0 },
    };
    await log({ type: "quota", label, payload });
    return payload;
  }
  if (forbidden || (process.env.BENCH_STOP_FILE && existsSync(process.env.BENCH_STOP_FILE)))
    throw new Error("Stopped; no account read/replay");
  const launch = museLaunchOptions({
    cwd: out,
    tools: ["read"],
    promptMode: "none",
  });
  await qualifyMuseVersion(launch.command, launch.env ?? {});
  const handshake = spawnMspConnection({
    ...launch,
    env: { ...launch.env, ...env },
  });
  try {
    const spawned = await handshake.initialize({
      clientInfo: { name: "pi_muse_verification_quota", version: "0.1.0" },
      capabilities: { requestedCapabilities: [], userInputDialogs: false },
    });
    // MSP1.4.14 UsageReadResult + SubscriptionUsage: query snapshot, no turn/start.
    const result = await spawned.connection.request("usage/read", {});
    if (denied(result)) {
      forbidden = true;
      throw new Error("HTTP 403 quota refusal");
    }
    const payload = quotaPayload(result.usage);
    // A new quota window may return allowance:null/server_sent_no_usage.
    // Unknown is an observation, not exhaustion; retain the native reason too.
    await log({ type: "quota", label, payload, observation: result });
    if (quotaExhausted(result.usage)) {
      denied({code:"plan_usage_limit_exceeded"}); forbidden=true;
      throw new Error("Provider quota exhausted; no candidate prompt submitted");
    }
    return payload;
  } catch (e) {
    if (denied({error:e})) forbidden = true;
    throw e;
  } finally {
    try { await handshake.close(); } catch(e) { denied({error:e}); throw e; }
  }
}
await writeFile(join(out, "doctor.json"), await museDoctor());
await writeFile(join(out, "synthetic.txt"), "VERIFICATION_SYNTHETIC_READ_VALUE\n");
await quota("before-candidate");
const pi = spawn(
  process.execPath,
  [
    join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "-ne",
    "-e",
    join(
      root,
      offline
        ? "tests/verification-entry-fixture.ts"
        : "index.ts",
    ),
    "--mode",
    "rpc",
    "--model",
    offline ? "pi-muse-tether/echo" : "pi-muse-tether/muse-spark-1.3",
    "--session",
    join(out, "session.jsonl"),
    "--tools",
    "read",
  ],
  { cwd: out, env, stdio: ["pipe", "pipe", "pipe"] },
);
const exited = once(pi, "exit");
let readCalls = 0;
let exit = false,
  seq = 0;
const waiters = new Set<any>();
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: any) => void }
>();
const refuse = (error: Error) => {
  for (const w of waiters) w.reject(error);
  waiters.clear();
  for (const w of pending.values()) w.reject(error);
  pending.clear();
};
void exited.then(([code, signal]) => {
  exit = true;
  refuse(new Error(`Pi exited ${code}/${signal}`));
});
const lines = createInterface({ input: pi.stdout });
lines.on("line", (line) => {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "tool_execution_start" && event.toolName === "read")
    readCalls++;
  // Synthetic proof transcript; never persist inherited environment/auth/headers.
  void log({ type: "pi", event });
  if (denied(event)) {
    forbidden = true;
    refuse(
      new Error(
        "First real 403/client_attestation_denied; root must stop, no replay",
      ),
    );
    pi.stdin.end();
    return;
  }
  if (event.type === "response" && pending.has(event.id)) {
    const w = pending.get(event.id)!;
    pending.delete(event.id);
    event.success
      ? w.resolve(event)
      : w.reject(new Error(event.error ?? "RPC rejected"));
  }
  for (const w of [...waiters])
    if (w.predicate(event)) {
      waiters.delete(w);
      w.resolve(event);
    }
});
// Raw diagnostics are neither persisted nor searched for error-like text.
pi.stderr.resume();
function rpc(type: string, fields: any = {}) {
  if (exit || forbidden)
    return Promise.reject(new Error("Candidate stopped; no retry"));
  const id = String(++seq);
  return new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    pi.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
  });
}
function event(predicate: (v: any) => boolean) {
  if (exit || forbidden) return Promise.reject(new Error("Candidate stopped"));
  return new Promise<any>((resolve, reject) =>
    waiters.add({ predicate, resolve, reject }),
  );
}
async function prompt(label: string, message: string, images?: any[]) {
  if (forbidden) throw new Error("Stopped after refusal");
  await quota(`before-${label}`);
  const readsBefore = readCalls;
  const start = performance.now(),
    end = event((e) => e.type === "agent_end");
  await rpc("prompt", { message, ...(images ? { images } : {}) });
  const done = await end;
  const durationMs = performance.now() - start;
  const assistants =
    done.messages?.filter((m: any) => m.role === "assistant") ?? [];
  let proofFailure: string | undefined;
  if (!offline || argv.includes("--check-answers")) {
    const text = assistants
      .flatMap((m: any) => m.content ?? [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n")
      .trim();
    proofFailure = answerFailure(label, text);
    if (proofFailure) {
      proofFailures.push({ label, reason: proofFailure });
      await log({ type: "proof-failure", label, reason: proofFailure, continueLaterStages: true });
    }
  }
  if (assistants.some((m: any) => ["error", "aborted"].includes(m.stopReason)))
    throw new Error(
      "Candidate request failed; stop without retry (inspect synthetic transcript)",
    );
  if (!offline && label === "ledger-tool" && readCalls - readsBefore !== 1)
    throw new Error("Live Pi read execution count is not exactly one; stop");
  await log({
    type: "measurement",
    proof: proofFailure ? "failed" : (!offline || argv.includes("--check-answers")) ? "passed" : "not-evaluated-offline",
    readCalls: readCalls - readsBefore,
    label,
    durationMs,
    messages: assistants.map((m: any) => ({
      usage: m.usage,
      nativeUsage: m.nativeUsage,
      usagePresence: m.usagePresence,
      usageInputSource: m.usageInputSource,
      usageTotalSource: m.usageTotalSource,
      costSource: m.costSource,
      costPartial: m.costPartial,
      responseModel: m.responseModel,
      responseModelSource: m.responseModelSource,
    })),
  });
  await quota(`after-${label}`);
  return durationMs;
}
try {
  const initial = await rpc("get_state");
  if (offline) assertOfflineModel(initial.data.model);
  await rpc("set_auto_retry", { enabled: false });
  await rpc("prompt", { message: "/muse-doctor" });
  // Every Pi tier is an explicit treatment; response reasoning text is not proof
  // of physical upstream effort. Root must compare official HTTP diagnostics if
  // available; do not claim that MSP acceptance alone proves API parity.
  for (const level of imageOnly ? [] : [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    const supported = await rpc("get_available_thinking_levels");
    if (!supported.data.levels.includes(level)) {
      await log({
        type: "unsupported-effort",
        level,
        source: "native-Pi-picker-from-official-Muse-model/list",
      });
      continue;
    }
    await rpc("set_thinking_level", { level });
    const effortState = await rpc("get_state");
    if (effortState.data.thinkingLevel !== level)
      throw new Error(
        "Pi silently changed requested effort; stop before model request",
      );
    await prompt(
      `effort-${level}`,
      "Synthetic reasoning check: compute 17*19. Return only the integer. Do not use tools.",
    );
  }
  const available = await rpc("get_available_thinking_levels");
  if (imageOnly) {
    if (!available.data.levels.includes("minimal")) throw new Error("Image-only requires advertised minimal effort");
    await rpc("set_thinking_level", { level: "minimal" });
  } else if (available.data.levels.includes("off"))
    await rpc("set_thinking_level", { level: "off" });
  // Larger valid red target removes the tiny-image confound; does not claim
  // that the original valid 1x1 PNG caused the live failure.
  const png = redPng();
  await writeFile(join(out, "red.png"), png);
  await prompt(
    "image-current",
    "Name the dominant color of the attached synthetic image. Return one word, no tools.",
    [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
  );
  if (!imageOnly) {
  const selected = await rpc("get_state");
  await rpc("new_session");
  await rpc("switch_session", { sessionPath: selected.data.sessionFile });
  await prompt(
    "image-import",
    "What was the dominant color of the image in the previous Pi history? One word, no tools.",
  );
  await prompt(
    "ledger-tool",
    `Use Pi read exactly once on ${join(out, "synthetic.txt")}; return its exact value. Do not use any other tool.`,
  );
  let idle = await prompt(
    "cache-warm",
    "Synthetic stable-prefix cache probe. Reply OK, no tools.",
  );
  if (argv.includes("--cache-probe")) {
    // Initial idle is MEASURED from this candidate's warm turn. Doubling is the
    // experimental increasing-gap schedule, not a TTL, timeout or workload cap.
    // Deliberate root cancellation is the stop condition; there is no billed ping.
    while (!forbidden) {
      await log({
        type: "cache-idle",
        idleMs: idle,
        source: "measured-initial-turn-duration;geometric-idle-experiment",
      });
      // Node timers documentation: delays above 2^31-1 ms become 1 ms.
      // Fail closed instead of accidentally turning a long idle into a burst.
      if(!Number.isFinite(idle)||idle>2147483647)throw new Error("Node timer range exceeded; operator must stop/review, no probe request");
      const sentinel=process.env.TTL_STOP_FILE;
      if(!sentinel)throw new Error("TTL_STOP_FILE explicit operator sentinel required");
      const stopped=await new Promise<boolean>((resolve,reject)=>{
        const watcher=watch(dirname(sentinel),()=>{if(existsSync(sentinel)){clearTimeout(timer);watcher.close();resolve(true);}});
        const timer=setTimeout(()=>{watcher.close();resolve(false);},idle);
        watcher.on("error",reject);
        if(existsSync(sentinel)){clearTimeout(timer);watcher.close();resolve(true);}
      });
      if(stopped){await log({type:"cache-probe-operator-stop",sentinel});break;}
      await prompt(
        "cache-after-idle",
        "Synthetic stable-prefix cache probe. Reply OK, no tools.",
      );
      idle += idle;
    }
  }
  }
  await rpc("get_session_stats");
  await quota("after-candidate");
} finally {
  pi.stdin.end();
  await exited;
  await log({ type: "finished", forbidden, proofFailures });
}
// Read metadata-only request ledger for root joins, never read auth.json.
// Fail the overall proof only AFTER later stages and readback finish.
if (proofFailures.length) process.exitCode = 1;
await log({
  type: "ledger-readback",
  body: await readFile(
    join(out, "state/pi-muse-tether/requests.jsonl"),
    "utf8",
  ),
});
