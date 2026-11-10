import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("../src/host.js", () => ({discoverMuseCatalog: vi.fn(), openMuseHost: vi.fn()}));
import { discoverMuseCatalog } from "../src/host.js";
import { registerMuseExtension } from "../index.js";
import { museCatalogAssessment, museCatalogModels } from "../src/catalog.js";
import { museModelRoute, museResponseIdentity } from "../src/model-route.js";
const catalog = JSON.parse(readFileSync(new URL("./fixtures/provider-catalog-window.json", import.meta.url), "utf8"));
const ember = {...catalog.models[0], modelId:"muse-ember-1.0", displayLabel:"Muse Ember"};
afterEach(() => {vi.unstubAllEnvs(); vi.resetAllMocks();});

it.each(["muse-ember-1.0", "muse-future-2.0"])("exposes unverified %s normally, preserving old recipes without contributor routes or prices", modelId => {
  const ember = {...catalog.models[0], modelId, displayLabel:"Unverified Muse"};
  const models = museCatalogModels({...catalog, models:[ember]});
  expect(models.map(m => m.id)).toEqual([ember.modelId]);
  expect(museModelRoute(`${ember.modelId}-contributor`)).toBeUndefined();
  for (const m of models) {
    expect(museModelRoute(m.id)).toEqual({modelId:ember.modelId, contributorMode:m.id.endsWith("-contributor") ? "on" : "off"});
    expect(m.contextWindow).toBe(ember.contextLimit);
    expect(m.maxTokens).toBe(ember.outputLimit);
    expect(m.cost).toEqual({input:null,output:null,cacheRead:null,cacheWrite:null});
    expect(m.name).toContain("pricing unknown");
    expect(m.name).toContain(" · Normal");
    expect(museResponseIdentity(m.id)).toMatchObject({responseModel:ember.modelId, contributorMode:"off"});
  }
  for (const id of ["muse-spark-1.3", "muse-spark-1.3-contributor"])
    expect(museModelRoute(id)).toEqual({modelId:"muse-spark-1.3", contributorMode:"on"});
  for (const id of ["muse-wonder-1.0", "muse-wonder-full-1.0"]) {
    expect(museModelRoute(id)).toEqual({modelId:id, contributorMode:"off"});
    expect(museModelRoute(`${id}-contributor`)).toEqual({modelId:id, contributorMode:"on"});
  }
});

it.each([null, "echo", "other-model", "muse-bad id", "--muse-flag"])("rejects malformed catalogue id %j", modelId => {
  const invalid = {...catalog,models:[{...ember,modelId}]};
  expect(museCatalogModels(invalid)).toEqual([]);
  expect(museCatalogAssessment(invalid).diagnostics.rejectedRoutes).toEqual([`${String(modelId)}: invalid Muse model ID shape`]);
});

it.each(["muse-ember-1.0-contributor", "muse-contributor"])("skips reserved native ID %s with a named diagnostic, without dropping other models", modelId => {
  const mixed = {...catalog, models:[{...ember,modelId}, ember, ...catalog.models]};
  expect(museCatalogModels(mixed)).toEqual(museCatalogModels({...mixed,models:mixed.models.slice(1)}));
  expect(museCatalogAssessment(mixed).diagnostics.rejectedRoutes).toEqual([`${modelId}: reserved local -contributor suffix`]);
});

it("refreshes the shipped extension at agent_end, adds/removes rows, updates metadata, and retains echo on discovery failure", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
  const discover = vi.mocked(discoverMuseCatalog);
  discover.mockResolvedValue(catalog);
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {};
  const pi: any = {registerProvider:vi.fn(), on:(name:string, handler:Function)=>{handlers[name]=handler;}, registerCommand:(name:string, spec:any)=>{commands[name]=spec;}};
  await registerMuseExtension(pi);
  const models = () => pi.registerProvider.mock.lastCall[1].models;
  expect(models().at(-1).id).toBe("echo");
  await handlers.agent_end();
  expect(pi.registerProvider).toHaveBeenCalledTimes(1);
  discover.mockResolvedValue({...catalog, models:[...catalog.models].reverse()});
  await handlers.agent_end();
  expect(pi.registerProvider).toHaveBeenCalledTimes(1);
  discover.mockResolvedValue({...catalog,models:[ember]});
  await handlers.agent_end();
  expect(models().map((m:any)=>m.id)).toEqual([ember.modelId, "echo"]);
  discover.mockResolvedValue({...catalog,models:[{...ember,variants:["high"],defaultReasoningEffort:"high",contextLimit:catalog.models[0].outputLimit}]});
  await handlers.agent_end();
  expect(models()[0].thinkingLevelMap.max).toBeNull();
  expect(models()[0].contextWindow).toBe(ember.outputLimit);
  expect(pi.registerProvider).toHaveBeenCalledTimes(3);
  discover.mockRejectedValue(new Error("fixture discovery unavailable"));
  await handlers.agent_end();
  expect(models().map((m:any)=>m.id)).toEqual(["echo"]);
  const notify = vi.fn();
  await commands["muse-doctor"].handler("",{ui:{notify}});
  expect(JSON.parse(notify.mock.lastCall![0]).catalogue).toEqual({status:"discovery failed",error:"fixture discovery unavailable"});
});

it("does not discover while live mode is disabled", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "0");
  const handlers: Record<string, Function> = {};
  const pi: any = {registerProvider:vi.fn(), on:(name:string, handler:Function)=>{handlers[name]=handler;}, registerCommand:vi.fn()};
  await registerMuseExtension(pi);
  await handlers.agent_end();
  expect(discoverMuseCatalog).not.toHaveBeenCalled();
  expect(pi.registerProvider).toHaveBeenCalledTimes(1);
  expect(pi.registerProvider.mock.lastCall[1].models.map((m:any)=>m.id)).toEqual(["echo"]);
});
