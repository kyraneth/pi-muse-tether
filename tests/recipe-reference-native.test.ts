import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { calculateCost, type Model } from "@earendil-works/pi-ai";
import { usageRecords } from "./recipe-reference-native-fixture.js";

it("native Pi registers both Spark aliases and prices distinct MSP requests before summing", async () => {
  const pi = process.env.RECIPE_REFERENCE_PI ?? resolve("node_modules/.bin/pi");
  const modelId = process.env.RECIPE_REFERENCE_MODEL ?? "muse-spark-1.2-contributor";
  const root = await mkdtemp(join(tmpdir(), "muse-reference-native-"));
  const agent = join(root, "agent"), tablesPath = join(root, "tables.json"), ledgerPath = join(root, "requests.jsonl");
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const { models, ...catalog } = JSON.parse(await readFile(new URL("fixtures/provider-catalog-window.json", import.meta.url), "utf8"));
  const catalogPath = join(root, "catalog.json"), calls = join(root, "calls.jsonl");
  await writeFile(catalogPath, JSON.stringify({ ...catalog, models: [...models, { ...models[0], modelId: "muse-ember-1.0", displayLabel: "Muse Ember" }] }));
  const child = spawn(pi, ["-ne", "-ns", "-np", "-nc", "--no-mcp", "--mode", "rpc",
    "--provider", "pi-muse-tether", "--model", modelId, "--thinking", "minimal", "--tools", "read",
    "--session-dir", join(root, "sessions"), "-e", resolve("tests/recipe-reference-native-fixture.ts")], {
    env: { ...process.env, HOME: root, PI_OFFLINE: "1", PI_MUSE_TETHER_LIVE: "1", PI_CODING_AGENT_DIR: agent,
      XDG_STATE_HOME: join(root, "state"), PI_MUSE_TETHER_BINARY: resolve("tests/fixtures/catalog-discovery.py"),
      CATALOG_ENTRY_FIXTURE: catalogPath, CATALOG_ENTRY_CALLS: calls, FIXTURE_HOST_LOG: join(root, "host.jsonl"),
      RECIPE_REFERENCE_EVIDENCE: JSON.stringify({ tablesPath, ledgerPath }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk);
  child.stdin.on("error", () => {});
  const wire: any[] = [];
  const lines = createInterface({ input: child.stdout });
  const exit = new Promise<number | null>((yes, no) => { child.once("error", no); child.once("close", yes); });
  child.stdin.write(JSON.stringify({ id: "picker", type: "get_available_models" }) + "\n");
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      wire.push(event);
      if (event.id === "picker") child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Offline recipe reference fixture." }) + "\n");
      if (event.type === "agent_settled" || event.id === "prompt" && event.success === false) break;
    }
  } finally {
    child.stdin.end();
    await exit;
    await writeFile(join(root, "rpc.jsonl"), wire.map(e => JSON.stringify(e)).join("\n") + "\n");
    await writeFile(join(root, "stderr.txt"), stderr);
    console.log("RECIPE_REFERENCE_NATIVE_EVIDENCE", root);
  }
  expect(await exit, stderr).toBe(0);
  const message = wire.find(e => e.type === "message_end" && e.message?.role === "assistant")?.message;
  expect(message?.stopReason, JSON.stringify(message ?? wire)).toBe("stop");
  const tables: Model<any>[] = JSON.parse(await readFile(tablesPath, "utf8"));
  const table = tables.find(model => model.id === modelId)!;
  expect(table, `Reference table absent for ${modelId}`).toBeDefined();
  const estimates = usageRecords.map(({ usage, totalTokens }) => calculateCost(table, {
    input: usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens, output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }));
  expect(message.model).toBe(modelId);
  expect(message.responseModel).toBe(modelId);
  expect(message.usage.cost.total).toBeCloseTo(estimates[0].total + estimates[1].total, 12);
  expect(message.usage).toMatchObject({ input: 18_001, output: 14, cacheRead: 380_000, cacheWrite: 2_000, totalTokens: 200_008 });
  expect(message.nativeUsage).toHaveLength(2);
  expect(message.nativeCumulativeCost).toMatchObject({ usd: 9, partial: true });
  expect(message.costPartial).toBe(false);
  const picker = wire.find(e => e.id === "picker").data.models.filter((m: any) => m.provider === "pi-muse-tether");
  expect(picker.find((m: any) => m.id === modelId)).toMatchObject({ cost: table.cost, inputLimits: table.inputLimits });
  expect(picker.filter((m: any) => m.id.startsWith("muse-spark-1.3")).map(({id, name}: any) => [id, name])).toEqual([
    ["muse-spark-1.3", "muse-spark-1.3 · Contributor (legacy alias)"],
    ["muse-spark-1.3-contributor", "muse-spark-1.3 · Contributor"],
  ]);
  const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const requests = ledger.filter(row => row.type === "request");
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map(row => row.episodeId)).size).toBe(1);
  requests.forEach((row, i) => {
    const { totalFromProvider: _, ...referenceCost } = estimates[i];
    expect(row).toMatchObject({ requestId: `request-${i}`, pickerModel: modelId, responseModel: modelId, physicalModel: null,
      referenceCost, referenceCostPartial: false });
  });
  expect(ledger.filter(row => row.type === "cumulative").map(row => row.costUsd)).toEqual([9, 9]);
  const host = (await readFile(join(root, "host.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const methods = host.filter(row => row.kind === "method").map(row => row.method);
  expect(methods).toContain("usage/read");
  expect(methods).not.toContain("usage/refresh");
  expect(host.filter(row => row.kind === "input")).toHaveLength(1);
  expect(ledger.filter(row => row.type === "rate_limit")).toEqual([
    expect.objectContaining({ window: expect.objectContaining({ usedPercent: 37 }), weekly: expect.objectContaining({ usedPercent: null }) }),
  ]);
});
