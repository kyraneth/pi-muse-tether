import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const cases = [
  ["unchanged", false], ["remove-first", false], ["reorder", false], ["empty", false],
  ...["429", "unnumbered", "policy", "post-ack", "validation", "transport-loss"].flatMap(scenario => [[scenario, false], [scenario, true]] as const),
] as const;
const parse = (jsonl: string) => jsonl.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

it.each(cases)("native logical hooks: %s (raw=%s)", async (scenario, raw) => {
  const root = await mkdtemp(join(tmpdir(), "logical-hooks-"));
  const agent = join(root, "agent"), hostLog = join(root, "host.jsonl");
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: true }, compaction: { enabled: false } }));
  await writeFile(hostLog, "");
  const prompt = "Exact synthetic system prompt.";
  const child = spawn(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--offline", "--mode", "json", "-ne", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--provider", "pi-muse-tether", "--model", "echo",
    ...(raw ? ["--no-tools"] : ["--tools", "first,second,third"]), "--session-dir", join(root, "sessions"),
    "--system-prompt", prompt, "-e", resolve("tests/logical-hooks-fixture.ts"), "Synthetic hook request."], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_MUSE_TETHER_LIVE: "0", LOGICAL_HOOK_SCENARIO: scenario, FIXTURE_HOST_LOG: hostLog },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const hooks: any[] = [];
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
    // A regression need not wait through Pi's own retry delays.
    if (stdout.includes('"type":"auto_retry_start"')) child.kill("SIGTERM");
  });
  child.stderr.on("data", chunk => stderr += chunk);
  child.on("message", (row: any) => {
    hooks.push(row);
    if (row.kind === "response") child.send("release");
  });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  await writeFile(join(root, "hooks.jsonl"), hooks.map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(root, "pi.jsonl"), stdout);
  await writeFile(join(root, "stderr.txt"), stderr);
  console.log("LOGICAL_HOOK_EVIDENCE", scenario, raw, root);
  expect(code, stderr).toBe(0);
  const events = parse(stdout), responses = hooks.filter(row => row.kind === "response");
  const assistants = events.filter(row => row.type === "message_end" && row.message?.role === "assistant");
  const inputs = parse(await readFile(hostLog, "utf8")).filter(row => row.kind === "input");
  const refusal = ["429", "unnumbered", "policy"].includes(scenario);
  const noResponse = ["validation", "transport-loss"].includes(scenario);
  expect(assistants).toHaveLength(1);
  expect(inputs).toHaveLength(scenario === "validation" ? 0 : 1);
  expect(events.some(row => row.type === "auto_retry_start" || row.type === "tool_execution_start")).toBe(false);
  expect(hooks.some(row => row.kind === "executed")).toBe(false);
  expect(responses).toHaveLength(noResponse ? 0 : 1);
  if (noResponse) {
    expect(assistants[0].message.stopReason).toBe("error");
    expect(hooks.some(row => row.kind === "stream")).toBe(false);
    if (scenario === "validation") expect(hooks.some(row => row.kind === "registered")).toBe(false);
    return;
  }
  expect(responses[0]).toMatchObject({ status: scenario === "429" ? 429 : scenario === "policy" ? 403 : 0, headers: {
    "x-pi-tether-transport": "official-muse-client",
    "x-pi-tether-response": refusal ? "logical-refusal" : "logical-admission",
  } });
  const order = (kind: string) => hooks.findIndex(row => row.kind === kind);
  expect(order("response")).toBeGreaterThan(order("payload"));
  expect(order("observer-released")).toBeGreaterThan(order("response"));
  expect(order("terminal")).toBeGreaterThan(order("observer-released"));
  if (refusal) {
    expect(order("pre-admission-frame-sent")).toBeGreaterThan(order("payload"));
    expect(order("fenced")).toBeGreaterThan(order("pre-admission-frame-sent"));
    // The merged tool-free host withholds the frame at ingress until identity
    // is known; coding can fold it but must not publish it past the hook gate.
    if (raw) expect(order("ingress")).toBe(-1);
    else expect(order("fenced")).toBeGreaterThan(order("ingress"));
    expect(order("response")).toBeGreaterThan(order("fenced"));
    expect(order("stream")).toBe(-1);
    expect(assistants[0].message).toMatchObject({ stopReason: "error", content: [] });
    if (scenario === "policy") {
      expect(order("policy-latched")).toBeGreaterThan(order("fenced"));
      expect(order("policy-latched")).toBeLessThan(order("observer-released"));
      expect(assistants[0].message.errorMessage).toBe(hooks.find(row => row.kind === "policy-latched").reason);
    }
    return;
  }
  expect(order("stream")).toBeGreaterThan(order("observer-released"));
  expect(responses[0].headers["x-pi-tether-acceptance"]).toBe("turn/start");
  expect(assistants[0].message.stopReason).toBe(scenario === "post-ack" ? "error" : "stop");
  const payload = hooks.find(row => row.kind === "payload"), registration = hooks.find(row => row.kind === "registered");
  expect(payload.transport).toBe("official-muse-client");
  expect(payload.systemPrompt).toContain(prompt);
  expect(registration.systemPrompt).toBe(payload.systemPrompt);
  if (!raw) expect(payload.tools[0].description).toContain("Transport notice:");
  const expected = scenario === "empty" ? [] : scenario === "remove-first" ? payload.tools.slice(1) :
    scenario === "reorder" ? payload.tools.toReversed().map(({ name }: any) => ({ name, description: `Edited ${name}` })) : payload.tools;
  expect(registration.tools).toEqual(expected);
  expect(registration.purpose).toBe(raw || scenario === "empty" ? "raw" : "coding");
}, 0);
