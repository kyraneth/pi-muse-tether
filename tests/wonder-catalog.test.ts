import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { museCatalogAssessment, museCatalogModels, museResponseIdentity } from "../src/catalog.js";
import { museModelRoute } from "../src/model-route.js";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
const catalog = JSON.parse(readFileSync(new URL("./fixtures/provider-catalog-window.json", import.meta.url), "utf8"));
catalog.models.push({...catalog.models[0], modelId:"muse-ember-1.0", displayLabel:"Muse Ember"});

describe("hand-written synthetic provider catalogue", () => {
  it("registers every catalogue row with its own limits and effort maps", () => {
    const models = museCatalogModels(catalog);
    expect(models.map(m => m.id)).toEqual(["muse-wonder-1.0", "muse-wonder-1.0-contributor", "muse-wonder-full-1.0", "muse-wonder-full-1.0-contributor", "muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-ember-1.0"]);
    for (const m of models) {
      const row = catalog.models.find((r: any) => r.modelId === museModelRoute(m.id)?.modelId);
      expect(m.contextWindow).toBe(row.contextLimit);
      expect(m.maxTokens).toBe(row.outputLimit);
      expect(Object.values(m.thinkingLevelMap).filter(Boolean)).toEqual(row.variants);
      expect(m.thinkingLevelMap.off).toBeNull();
      expect(m.name).toContain(museModelRoute(m.id)?.contributorMode === "on" ? " · Contributor" : " · Normal");
    }
  });
  it.each(["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"])("keeps the other models when %s is absent", id => {
    const models = museCatalogModels({...catalog, models: catalog.models.filter((m: any) => m.modelId !== id)});
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => museModelRoute(m.id)?.modelId === id)).toBe(false);
  });
  it.each([null, [], ["invented"]])("omits ungrounded or default-incompatible variants %j", variants => {
    expect(museCatalogModels({...catalog, models: catalog.models.map((m: any) => ({...m, variants}))})).toEqual([]);
  });
  it("has no required model groups and never accepts a bundled source", () => {
    expect(museCatalogAssessment(catalog).diagnostics).not.toHaveProperty("missing");
    expect(museCatalogModels({...catalog,source:"bundledCatalog"})).toEqual([]);
  });
  it("projects only the exact recipe's installed reference table and input limits", () => {
    const references = getBuiltinModels("meta");
    for (const m of museCatalogModels(catalog)) {
      const legacyAlias = m.id === "muse-spark-1.3";
      const responseModel = legacyAlias ? "muse-spark-1.3-contributor" : m.id;
      expect(museResponseIdentity(m.id)).toMatchObject({ responseModel, responseModelSource: expect.stringMatching(/^derived:/) });
      const table = references.find(row => row.id === responseModel);
      expect(m.cost).toEqual(table?.cost ?? {input:null,output:null,cacheRead:null,cacheWrite:null});
      expect(m.inputLimits).toEqual(table?.inputLimits);
      expect(m.name.includes("pricing unknown")).toBe(!table);
      expect(m.name.includes("(legacy alias)")).toBe(legacyAlias);
    }
  });
});
