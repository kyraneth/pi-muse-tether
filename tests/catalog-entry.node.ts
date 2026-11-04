import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// Hand-written synthetic catalogue fixture exercising the same derivation contract;
// it is not a captured official response and asserts no captured window values.
const historical = JSON.parse(await readFile(join(here, "fixtures/provider-catalog.json"), "utf8"));
const spark = historical.models.find((m: any) => m.modelId === "muse-spark-1.3");

async function entry(catalog: any, modelId = "muse-spark-1.3", effort = "high") {
  const out = await mkdtemp(join(tmpdir(), "muse-catalog-entry-"));
  const agent = join(out, "agent");
  await mkdir(agent);
  const catalogPath = join(out, "catalog.json"), calls = join(out, "calls.jsonl");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
    PI_MUSE_TETHER_LIVE: "1", MUSE_NO_AUTO_UPDATE: "1",
    PI_MUSE_TETHER_BINARY: join(here, "fixtures/catalog-discovery.py"),
    CATALOG_ENTRY_FIXTURE: catalogPath, CATALOG_ENTRY_CALLS: calls,
  };
  // Same real Pi CLI, loader, default extension entry and requested model as fixture.
  // No prompt is ever sent. A synthetic agent directory contains no credentials.
  const argv = ["-ne", "-ns", "-np", "-nc", "--no-mcp", "--mode", "rpc",
    "--provider", "pi-muse-tether", "--model", modelId, "--thinking", effort,
    "-e", process.env.CATALOG_ENTRY_EXTENSION ?? join(root, "index.ts")];
  const p = spawn(join(root, "node_modules/.bin/pi"), argv, { cwd: out, env });
  let stdout = "", stderr = "", pending = "";
  const replies: any[] = [];
  p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
  p.stdout.on("data", chunk => {
    stdout += chunk; pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const reply = JSON.parse(line); replies.push(reply);
        if (reply.type === "response" && reply.id === "state") p.stdin.end();
      } catch { /* Preserve non-JSON startup diagnostics verbatim. */ }
    }
  });
  p.stderr.on("data", chunk => stderr += chunk);
  p.stdin.on("error", () => {}); // Startup refusal can close stdin before get_state.
  const exited = new Promise<number | null>((yes, no) => { p.once("error", no); p.once("close", yes); });
  p.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
  const code = await exited;
  const wire = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const result = { code, stdout, stderr, replies, wire, argv, out };
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("catalog entry evidence: " + join(out, "result.json"));
  assert.deepEqual(wire.filter(x => x.method).map(x => x.method), ["initialize", "initialized", "model/list"]);
  return result;
}

for (const [label, catalog] of [
  ["missing qualified model", { ...historical, models: historical.models.filter((m: any) => !m.modelId.startsWith("muse-spark")) }],
  ["missing Wonder", { ...historical, models: historical.models.filter((m: any) => m.modelId !== "muse-wonder-1.0") }],
  ["missing Wonder Full", { ...historical, models: historical.models.filter((m: any) => m.modelId !== "muse-wonder-full-1.0") }],
  ["unknown limits", { ...historical, models: [{ ...spark, contextLimit: null, outputLimit: null }] }],
  ["bundled fallback", { ...historical, source: "bundledCatalog", models: [{ ...historical.models[0], contextLimit: null, outputLimit: null }] }],
  ["empty fallback", { ...historical, source: "bundledCatalog", models: [] }],
  ["bundled Spark is not a live catalogue", { ...historical, source: "bundledCatalog" }],
] as const) {
  test("real Pi entry refuses " + label + " before custom-model fallback", async () => {
    const result = await entry(catalog), diagnostics = result.stdout + result.stderr;
    assert.notEqual(result.code, 0);
    assert.match(diagnostics, /Muse catalogue/);
    assert.ok(diagnostics.includes(catalog.source), diagnostics);
    assert.ok(diagnostics.includes(catalog.providerId), diagnostics);
    assert.ok(diagnostics.includes(catalog.profileId), diagnostics);
    assert.doesNotMatch(diagnostics, /Using custom model id/);
    assert.equal(result.replies.some(x => x.id === "state"), false, "no session with an echo-cloned Spark placeholder");
  });
}

test("real Pi entry registers historical Spark metadata without a model request", async () => {
  const result = await entry(historical);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /Using custom model id/);
  const state = result.replies.find(x => x.id === "state");
  assert.equal(state?.success, true);
  assert.equal(state.data.messageCount, 0);
  const model = state.data.model;
  assert.equal(model.provider, "pi-muse-tether"); assert.equal(model.id, spark.modelId);
  assert.equal(model.contextWindow, spark.contextLimit); assert.equal(model.maxTokens, spark.outputLimit);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.cost.input, 0.1); // Existing contributor tariff, not echo's zero-cost placeholder.
});

const current = JSON.parse(await readFile(join(here, "fixtures/provider-catalog-window.json"), "utf8"));
for (const row of current.models.filter((m: any) => ["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"].includes(m.modelId))) {
  for (const pickerId of row.modelId.includes("wonder") ? [row.modelId, `${row.modelId}-contributor`] : [row.modelId])
  for (const effort of row.variants) test(`real Pi loader selects ${pickerId} at ${effort}, no inference`, async () => {
    const result = await entry(current, pickerId, effort);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /Using custom model id/);
    const state = result.replies.find(x => x.id === "state");
    assert.equal(state?.success, true);
    assert.equal(state.data.messageCount, 0);
    assert.equal(state.data.model.id, pickerId);
    assert.equal(state.data.thinkingLevel, effort);
    assert.equal(state.data.model.contextWindow, row.contextLimit);
    assert.equal(state.data.model.maxTokens, row.outputLimit);
    assert.equal(state.data.model.thinkingLevelMap.off, null);
    if (row.modelId.includes("wonder")) {
      assert.deepEqual(state.data.model.cost, {input:null,output:null,cacheRead:null,cacheWrite:null});
      assert.match(state.data.model.name, /pricing unknown/);
    }
  });
}
