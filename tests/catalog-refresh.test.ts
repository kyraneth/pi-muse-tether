import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
vi.mock("../src/host.js", () => ({discoverMuseCatalog: vi.fn(), openMuseHost: vi.fn()}));
vi.mock("../src/catalog-cache.js", async importOriginal => ({...(await importOriginal<typeof import("../src/catalog-cache.js")>()),
  catalogueIdentity: async () => "fixture-account", readCatalogue: vi.fn(), saveCatalogue: vi.fn(),
}));
import { discoverMuseCatalog } from "../src/host.js";
import { registerMuseExtension } from "../index.js";
import { museCatalogAssessment, museCatalogModels } from "../src/catalog.js";
import { museModelRoute, museResponseIdentity } from "../src/model-route.js";
const catalog = JSON.parse(readFileSync(new URL("./fixtures/provider-catalog-window.json", import.meta.url), "utf8"));
const ember = {...catalog.models[0], modelId:"muse-ember-1.0", displayLabel:"Muse Ember"};
afterEach(() => {vi.unstubAllEnvs(); vi.resetAllMocks();});

it.each(["muse-ember-1.0", "muse-future-2.0"])("exposes %s normally without inventing a contributor route or price", modelId => {
  const ember = {...catalog.models[0], modelId, displayLabel:"Unverified Muse"};
  const models = museCatalogModels({...catalog, models:[ember]});
  expect(models.map(m => m.id)).toEqual([ember.modelId]);
  expect(museModelRoute(`${ember.modelId}-contributor`)).toBeUndefined();
  for (const m of models) {
    expect(museModelRoute(m.id)).toEqual({modelId:ember.modelId, contributorMode:m.id.endsWith("-contributor") ? "on" : "off"});
    expect(m.contextWindow).toBe(ember.contextLimit);
    expect(m.maxTokens).toBe(ember.outputLimit);
    const table = getBuiltinModels("meta").find(row => row.id === modelId);
    expect(m.cost).toEqual(table?.cost ?? {input:null,output:null,cacheRead:null,cacheWrite:null});
    expect(m.name.includes("pricing unknown")).toBe(!table);
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

it("refreshes the shipped extension and retains the last catalogue on discovery failure", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
  const discover = vi.mocked(discoverMuseCatalog);
  discover.mockResolvedValue(catalog);
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {};
  const pi: any = {registerProvider:vi.fn(), on:(name:string, handler:Function)=>{handlers[name]=handler;}, registerCommand:(name:string, spec:any)=>{commands[name]=spec;}};
  await registerMuseExtension(pi);
  const config = pi.registerProvider.mock.lastCall[1];
  const signal = new AbortController().signal, publish = async ({update}: any) => {update(); return true;};
  const refresh = (allowNetwork = true, update = publish) => config.refreshModels({signal,allowNetwork,publish:update});
  expect(config.models.at(-1).id).toBe("echo");
  const backgroundNotice = vi.fn();
  await handlers.session_start({}, {ui:{notify:backgroundNotice,setStatus:vi.fn()}, sessionManager:{getSessionFile:()=>null}});
  expect(backgroundNotice).not.toHaveBeenCalled();
  expect(handlers.agent_end).toBeUndefined();
  await refresh(false);
  expect(discover).toHaveBeenCalledTimes(1);
  discover.mockResolvedValue({...catalog,models:[{...ember,variants:["high"],defaultReasoningEffort:"high",contextLimit:ember.outputLimit}]});
  const changed = await refresh();
  expect(changed.map((m:any)=>m.id)).toEqual([ember.modelId, "echo"]);
  expect(changed[0].thinkingLevelMap.max).toBeNull();
  expect(changed[0].contextWindow).toBe(ember.outputLimit);
  discover.mockRejectedValue(new Error("fixture discovery unavailable"));
  expect(await refresh()).toEqual(changed);
  expect(backgroundNotice).not.toHaveBeenCalled();
  const notify = vi.fn();
  const modelRegistry = {refresh:vi.fn(async () => ({errors:new Map(),models:await refresh()}))};
  await commands["muse-doctor"].handler("refresh",{ui:{notify},modelRegistry});
  expect(modelRegistry.refresh).toHaveBeenCalledWith({providers:["pi-muse-tether"],allowNetwork:true,force:true});
  expect(JSON.parse(notify.mock.lastCall![0]).catalogue).toMatchObject({status:"retaining stale picker metadata",error:"fixture discovery unavailable"});
  discover.mockResolvedValue({...catalog,source:"bundledCatalog",models:[]});
  expect(await refresh()).toEqual(changed);
  discover.mockResolvedValue({...catalog,models:[]});
  expect(await refresh(true, async () => false)).toEqual(changed);
  expect((await refresh()).map((m:any)=>m.id)).toEqual(["echo"]);
});

it("starts with echo and warns if initial discovery fails", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
  vi.mocked(discoverMuseCatalog).mockRejectedValue(new Error("offline fixture"));
  const handlers: Record<string, Function> = {};
  const pi: any = {registerProvider:vi.fn(), on:(name:string, handler:Function)=>{handlers[name]=handler;}, registerCommand:vi.fn()};
  await registerMuseExtension(pi, {streamViaMuse:vi.fn(),retireAll:vi.fn(),setSessionManager:vi.fn(),rawCompletionQualified:vi.fn(),committedCompaction:vi.fn()} as any);
  expect(pi.registerProvider.mock.lastCall[1].models.map((m:any)=>m.id)).toEqual(["echo"]);
  const notify = vi.fn();
  await handlers.session_start({}, {ui:{notify,setStatus:vi.fn()}, sessionManager:{getSessionFile:()=>null}});
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Catalogue discovery failed: offline fixture"), "warning");
});

it("does not discover while live mode is disabled", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", undefined);
  const notify = vi.fn();
  const handlers: Record<string, Function> = {};
  const pi: any = {registerProvider:vi.fn(), on:(name:string, handler:Function)=>{handlers[name]=handler;}, registerCommand:vi.fn()};
  await registerMuseExtension(pi);
  expect(handlers.agent_end).toBeUndefined();
  expect(discoverMuseCatalog).not.toHaveBeenCalled();
  await handlers.session_start({}, {ui:{notify,setStatus:vi.fn()}, sessionManager:{getSessionFile:()=>null}});
  expect(notify).not.toHaveBeenCalled();
  expect(pi.registerProvider).toHaveBeenCalledTimes(1);
  expect(pi.registerProvider.mock.lastCall[1].models.map((m:any)=>m.id)).toEqual(["echo"]);
});
