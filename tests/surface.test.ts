import { assertOfflineModel, fixtureModel } from "./verification-offline-guard.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile, stat, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertQualifiedVersions } from "../src/cli-version.js";
import {
  museEffort,
  museThinkingLevelMap,
  thinkingFrame,
} from "../src/thinking-config.js";
import { museUserParts, museHistoryParts } from "../src/image-input.js";
import { applyMuseUsage, CONTRIBUTOR_COST } from "../src/usage.js";
import {
  quotaPayload,
  quotaExhausted,
  setQuotaListener,
  publishQuota,
} from "../src/rate-limit.js";
import {
  MuseLedger,
  flushMuseLedger,
  museLedgerPath,
} from "../src/request-ledger.js";
import { museLaunchOptions } from "../src/host.js";
import { MUSE_CACHE_POLICY } from "../src/cache-policy.js";
afterEach(() => {
  vi.unstubAllEnvs();
  setQuotaListener(undefined);
});
const make = () =>
  ({
    model: "muse-spark-1.3",
    content: [],
    nativeUsage: [],
    usagePresence: {
      input: false,
      output: false,
      cacheRead: false,
      cacheWrite: false,
    },
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {},
    },
  }) as any;
describe("Muse surface contracts; no inference", () => {
  it("requires the client floor and independently pinned SDK, never forwards Meta key", () => {
    expect(
      assertQualifiedVersions("Muse Code 1.4.14 (1.4.14-R7309.1)", "1.4.14"),
    ).toEqual({ client: "1.4.14", sdk: "1.4.14" });
    for (const version of [
      "Muse Code 1.4.13",
      "Muse Code 1.4.0",
      "not Muse 1.4.14",
      "Muse Code 1.4.14 garbage",
    ])
      expect(() => assertQualifiedVersions(version, "1.4.14")).toThrow(
        /Unqualified/,
      );
    expect(() => assertQualifiedVersions("Muse Code 1.4.14", "1.4.15")).toThrow(
      /SDK/,
    );
    vi.stubEnv("META_API_KEY", "SYNTHETIC-KEY-MUST-NOT-PASS");
    vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
    expect(
      museLaunchOptions({
        cwd: process.cwd(),
        tools: ["read"],
        promptMode: "none",
      }).env,
    ).not.toHaveProperty("META_API_KEY");
  });
  it("maps every Pi tier explicitly; off never inherits max", () => {
    for (const [level, expected] of [
      [undefined, "none"],
      ["off", "none"],
      ["minimal", "minimal"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ])
      expect(museEffort(level)).toBe(expected);
    expect(() => museEffort("ultra")).toThrow(/Unsupported/);
  });
  it("emits only exposed reasoning and no made-up signature", () => {
    const o = make(),
      events: any[] = [],
      stream = { push: (e: any) => events.push(e) },
      map = new Map<string, number>();
    thinkingFrame(
      o,
      stream,
      {
        method: "item/started",
        params: { item: { kind: "reasoning", itemId: "r" } },
      },
      map,
    );
    expect(o.content).toEqual([]);
    thinkingFrame(
      o,
      stream,
      {
        method: "item/delta",
        params: { itemId: "r", field: "summary.0", delta: "native summary" },
      },
      map,
    );
    thinkingFrame(
      o,
      stream,
      {
        method: "item/completed",
        params: {
          item: { kind: "reasoning", itemId: "r", text: "not duplicated" },
        },
      },
      map,
    );
    expect(o.content).toEqual([
      { type: "thinking", thinking: "native summary" },
    ]);
    expect(events.map((x) => x.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_end",
    ]);
  });
  it("supports real MSP image parts and preserves images from imported history", () => {
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
    expect(
      museUserParts({ content: [{ type: "text", text: "look" }, image] }),
    ).toEqual([
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
    ]);
    const imported = museHistoryParts([
      { role: "user", content: [image] },
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "user", content: "new" },
    ]);
    expect(imported.filter((p) => p.type === "image")).toHaveLength(1);
    expect(imported[0].text).toContain("PI IMAGE entry=0 block=0");
    expect(() =>
      museUserParts({ content: [{ ...image, data: "invalid" }] }),
    ).toThrow(/base64/);
    expect(() => museUserParts({ content: [{ type: "audio" }] })).toThrow(
      /unsupported/,
    );
  });
  it("retains native counters, subtracts cached input exactly once, last context not spend; contributor pricing only", () => {
    const o = make();
    const p = {
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        cachedTokens: 80,
        reasoningTokens: 5,
      },
      totalTokens: 110,
      cumulative: { cost: { usd: 3, partial: true } },
    };
    applyMuseUsage(o, p);
    applyMuseUsage(o, { ...p, totalTokens: 111 });
    expect(o.nativeUsage[0].inputTokens).toBe(100);
    expect(o.usage.input).toBe(40);
    expect(o.usage.cacheRead).toBe(160);
    expect(o.usage.output).toBe(20);
    expect(o.usage.totalTokens).toBe(111);
    expect(CONTRIBUTOR_COST).toEqual({
      input: 0.1,
      output: 0.2,
      cacheRead: 0.002,
      cacheWrite: 0,
    });
    expect(o.usage.cost.total).toBeCloseTo(
      (40 * 0.1 + 160 * 0.002 + 20 * 0.2) / 1e6,
      12,
    );
    expect(o.costSource).toMatch(/^derived:/);
    expect(o.nativeCumulativeCost.usd).toBe(3);
    expect(() =>
      applyMuseUsage(make(), { usage: { inputTokens: 1, cacheReadTokens: 2 } }),
    ).toThrow(/exceeds/);
    const unknown = make();
    applyMuseUsage(unknown, { usage: { outputTokens: 0 } });
    expect(unknown.usagePresence.input).toBe(false);
    expect(unknown.nativeUsage[0].inputTokens).toBeNull();
    expect(unknown.costPartial).toBe(true);
  });
  it("projects quota verbatim, reports unknown as null, publishes status and exhausted boundary", () => {
    const usage = {
      observedAtMs: 123,
      tier: "contributor",
      window: { usedPercent: 101, resetsAtMs: 456, windowDurationMins: 300 },
      weekly: { usedPercent: 25, resetsAtMs: 789 },
      secret: "NEVER",
    };
    const payload = quotaPayload(usage);
    expect(payload.window.usedPercent).toBe(101);
    expect(JSON.stringify(payload)).not.toContain("NEVER");
    expect(quotaPayload(undefined).weekly.usedPercent).toBeNull();
    expect(quotaExhausted(usage)).toBe(true);
    expect(quotaExhausted({ window: { usedPercent: 99 } })).toBe(false);
    const received: any[] = [];
    setQuotaListener((p) => received.push(p));
    publishQuota(usage);
    expect(received).toEqual([payload]);
  });
  it.each(["on", "off"] as const)("writes selected %s tier private metadata, deduplicates native requests, does not add cumulative counters", async (contributorMode) => {
    const dir = await mkdtemp(join(tmpdir(), "muse-verification-ledger-"));
    vi.stubEnv("XDG_STATE_HOME", dir);
    await mkdir(join(dir, "pi-muse-tether"));
    await writeFile(museLedgerPath(), "", { mode: 0o666 });
    const pickerModel = contributorMode === "on" ? "muse-wonder-1.0-contributor" : "muse-wonder-1.0";
    const ledger = new MuseLedger("pi-session", "muse-wonder-1.0", contributorMode, pickerModel);
    ledger.opened("msp-session");
    ledger.beginEpisode();
    const frame = {
      method: "session/tokenUsage",
      params: {
        sourceRange: { last: { id: "request1" } },
        turnId: "turn1",
        modelId: "native-model",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 80,
          secret: "NEVER-LEDGER",
        },
        cumulative: {
          promptTokens: 100,
          totalTokens: 110,
          cost: { usd: 2, partial: true },
        },
        promptTokens: 100,
        totalTokens: 110,
        content: "NEVER-LEDGER",
        toolArgs: { secret: "NEVER-LEDGER" },
      },
    };
    ledger.observe(frame);
    ledger.observe(frame);
    ledger.endEpisode();
    ledger.observe({
      ...frame,
      params: { ...frame.params, sourceRange: { last: { id: "request2" } } },
    });
    ledger.quota({ window: { usedPercent: 10 }, secret: "NEVER-LEDGER" });
    ledger.retire("session_shutdown");
    await flushMuseLedger();
    const body = await readFile(museLedgerPath(), "utf8"),
      rows = body.trim().split("\n").map((line) => JSON.parse(line));
    expect(body).not.toContain("NEVER-LEDGER");
    expect(rows.every(r => r.contributorMode === contributorMode && r.pickerModel === pickerModel && r.requestedModel === "muse-wonder-1.0")).toBe(true);
    expect((await stat(museLedgerPath())).mode & 0o777).toBe(0o600);
    const requests = rows.filter((r) => r.type === "request");
    expect(requests).toHaveLength(2);
    expect(requests[0].usage.inputTokens).toBe(100);
    expect(requests[0].nativeReportedModel).toBe("native-model");
    expect(requests[0].physicalModel).toBeNull();
    expect(requests[0].physicalModelSource).toMatch(/^unknown:/);
    expect(requests[0].episodeId).not.toBeNull();
    expect(requests[1].episodeId).toBeNull();
    expect(requests[1].receivedDetached).toBe(true);
    expect(rows.filter((r) => r.type === "cumulative")).toHaveLength(2);
    expect(rows.at(-1).reason).toBe("session_shutdown");
  });
  it("parks without invented TTL or billed refresh", () => {
    expect(MUSE_CACHE_POLICY.ttlSeconds).toBeNull();
    expect(MUSE_CACHE_POLICY.billedKeepalive).toBe(false);
    expect(MUSE_CACHE_POLICY.parking).toBe("until-Pi-retires");
  });
});

it("rejects builtin transport metadata before offline dispatch", () => {
  const builtin = {
    api: "openai-responses",
    provider: "meta",
    baseUrl: "https://api.meta.ai/v1",
    cost: {},
    contextWindow: 1048576,
    maxTokens: 131072,
  };
  const definition = fixtureModel(builtin);
  expect(definition).not.toHaveProperty("api");
  expect(definition).not.toHaveProperty("baseUrl");
  expect(definition).not.toHaveProperty("provider");
  expect(() =>
    assertOfflineModel({ ...builtin, id: "echo", provider: "pi-muse-tether" }),
  ).toThrow(/OFFLINE ROUTE GUARD/);
  expect(() =>
    assertOfflineModel({
      ...definition,
      api: "pi-muse-tether",
      provider: "pi-muse-tether",
      baseUrl: "pi-muse-tether",
    }),
  ).not.toThrow();
});

it("picker offers only official catalog effort tiers, not unsupported max or fabricated unknown", () => {
  expect(museThinkingLevelMap(["none", "low", "high"])).toEqual({
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  expect(
    Object.values(museThinkingLevelMap("unknown")).every((x) => x === null),
  ).toBe(true);
});

it("retains committed reasoning summary when the vendor sent no live delta", () => {
  const o = make(),
    stream = { push: () => {} },
    map = new Map<string, number>();
  thinkingFrame(
    o,
    stream,
    {
      method: "item/completed",
      params: {
        item: {
          kind: "reasoning",
          itemId: "summary-only",
          summary: ["one", "two"],
        },
      },
    },
    map,
  );
  expect(o.content).toEqual([{ type: "thinking", thinking: "one\ntwo" }]);
});
