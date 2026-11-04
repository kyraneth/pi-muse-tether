import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { museCatalogModels, museResponseIdentity } from "../src/catalog.js";
import { museModelRoute } from "../src/model-route.js";
import { applyMuseUsage, CONTRIBUTOR_COST } from "../src/usage.js";
const catalog = JSON.parse(readFileSync(new URL("./fixtures/provider-catalog-window.json", import.meta.url), "utf8"));

describe("hand-written synthetic provider catalogue", () => {
  it("registers exactly supported rows with their own limits and effort maps", () => {
    const models = museCatalogModels(catalog);
    expect(models.map(m => m.id)).toEqual(["muse-wonder-1.0", "muse-wonder-1.0-contributor", "muse-wonder-full-1.0", "muse-wonder-full-1.0-contributor", "muse-spark-1.3"]);
    for (const m of models) {
      const row = catalog.models.find((r: any) => r.modelId === museModelRoute(m.id)?.modelId);
      expect(m.contextWindow).toBe(row.contextLimit);
      expect(m.maxTokens).toBe(row.outputLimit);
      expect(Object.values(m.thinkingLevelMap).filter(Boolean)).toEqual(row.variants);
      expect(m.thinkingLevelMap.off).toBeNull();
    }
  });
  it.each(["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"])("refuses missing required %s without an echo-cloned fallback", id => {
    expect(() => museCatalogModels({...catalog, models: catalog.models.filter((m: any) => m.modelId !== id)})).toThrow(/Muse catalogue.*missing/);
  });
  it.each([null, [], ["invented"], ["high"]])("refuses ungrounded or default-incompatible variants %j", variants => {
    expect(() => museCatalogModels({...catalog, models: catalog.models.map((m: any) => ({...m, variants}))})).toThrow(/Muse catalogue/);
  });
  it("does not price Wonder using Spark or invent a Wonder contributor physical ID", () => {
    for (const m of museCatalogModels(catalog)) {
      const wonder = m.id.includes("wonder");
      expect(m.cost).toEqual(wonder ? {input:null,output:null,cacheRead:null,cacheWrite:null} : CONTRIBUTOR_COST);
      const identity: any = museResponseIdentity(m.id);
      if (wonder) {
        expect(m.name).toContain("pricing unknown");
        expect(identity.responseModel).toBeUndefined();
        expect(identity.responseModelSource).toMatch(/^unknown:/);
        expect(identity.contributorMode).toBe(m.id.endsWith("-contributor") ? "on" : "off");
        expect(identity.nativeModel).toBe(museModelRoute(m.id)?.modelId);
      } else expect(identity.responseModel).toBe("muse-spark-1.3-contributor");
      const output: any = {model:m.id, nativeUsage:[], usagePresence:{}, usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{}}};
      applyMuseUsage(output, {usage:{inputTokens:100,outputTokens:10,cacheReadTokens:80,cacheWriteTokens:0},totalTokens:110});
      expect(output.usage.input).toBe(20);
      expect(output.usage.cost.total === null).toBe(wonder);
      if (wonder) { expect(output.costPartial).toBe(true); expect(output.costSource).toMatch(/^unknown:/); }
      else expect(output.usage.cost.total).toBeCloseTo((20*.1+10*.2+80*.002)/1e6);
    }
  });
});
