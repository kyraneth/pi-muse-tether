import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {createInterface} from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// Hand-written synthetic catalogue fixture exercising the same derivation contract;
// it is not a captured official response and asserts no captured window values.
const historical = JSON.parse(await readFile(join(here, "fixtures/provider-catalog.json"), "utf8"));
const spark = historical.models.find((m: any) => m.modelId === "muse-spark-1.3");

async function entry(catalog: any, modelId = "muse-spark-1.3", effort = "high", shared?: string) {
  const out = await mkdtemp(join(tmpdir(), "muse-catalog-entry-"));
  const agent = join(out, "agent");
  await mkdir(agent);
  const config = join(shared ?? out, "config");
  const binary = join(shared ?? out, "muse-bin-1.4.14-R7309.1");
  if (!shared) {
    await mkdir(join(config, "muse"), {recursive:true});
    await writeFile(join(config, "muse", "auth.json"), "synthetic fixture; never read by adapter");
    await symlink(join(here, "fixtures/catalog-discovery.py"), binary);
  }
  const catalogPath = join(out, "catalog.json"), calls = join(out, "calls.jsonl");
  await writeFile(calls, "");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const env = { ...process.env, HOME: shared ?? out, XDG_STATE_HOME: join(out, "state"), XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(shared ?? out, "cache"), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
    PI_MUSE_TETHER_LIVE: "1", MUSE_NO_AUTO_UPDATE: "1",
    PI_MUSE_TETHER_BINARY: binary,
    CATALOG_ENTRY_FIXTURE: catalogPath, CATALOG_ENTRY_CALLS: calls,
  };
  // Same real Pi CLI, loader, default extension entry and requested model as fixture.
  // No prompt is ever sent. A synthetic agent directory contains no credentials.
  const argv = ["-ne", "-ns", "-np", "-nc", "--no-mcp", "--mode", "rpc",
    "--provider", "pi-muse-tether", "--model", modelId, "--thinking", effort,
    "-e", process.env.CATALOG_ENTRY_EXTENSION ?? join(root, "index.ts")];
  const p = spawn(process.env.CATALOG_ENTRY_PI ?? join(root, "node_modules/.bin/pi"), argv, { cwd: out, env });
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
  const wire = (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const result = { code, stdout, stderr, replies, wire, argv, out };
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("catalog entry evidence: " + join(out, "result.json"));
  if (!shared) assert.deepEqual(wire.filter(x => x.method).map(x => x.method), ["initialize", "initialized", "model/list"]);
  return result;
}

for (const [label, catalog] of [
  ["discovery failure", { offlineFailure: true }],
  ["missing qualified model", { ...historical, models: historical.models.filter((m: any) => !m.modelId.startsWith("muse-spark")) }],
  ["missing Wonder", { ...historical, models: historical.models.filter((m: any) => m.modelId !== "muse-wonder-1.0") }],
  ["missing Wonder Full", { ...historical, models: historical.models.filter((m: any) => m.modelId !== "muse-wonder-full-1.0") }],
  ["unknown limits", { ...historical, models: [{ ...spark, contextLimit: null, outputLimit: null }] }],
  ["bundled fallback", { ...historical, source: "bundledCatalog", models: [{ ...historical.models[0], contextLimit: null, outputLimit: null }] }],
  ["empty fallback", { ...historical, source: "bundledCatalog", models: [] }],
  ["bundled Spark is not a live catalogue", { ...historical, source: "bundledCatalog" }],
] as const) {
  test("real Pi entry retains echo for " + label, async () => {
    const result = await entry(catalog, "echo", "off");
    assert.equal(result.code, 0, result.stderr);
    const state = result.replies.find(x => x.id === "state");
    assert.equal(state?.success, true);
    assert.equal(state.data.model.id, "echo");
    assert.equal(state.data.model.provider, "pi-muse-tether");
    if (label === "discovery failure") assert.ok(result.replies.some(x => x.method === "notify" && x.notifyType === "warning" && x.message.includes("Catalogue discovery failed")));
    assert.doesNotMatch(result.stdout + result.stderr, /Using custom model id/);
  });
}

test("real Pi entry registers Spark from a partial provider catalogue", async () => {
  const result = await entry({...historical, models:[spark]});
  assert.equal(result.code, 0, result.stderr);
  const state = result.replies.find(x => x.id === "state");
  assert.equal(state?.data.model.id, spark.modelId);
  assert.doesNotMatch(result.stdout + result.stderr, /Using custom model id/);
});

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

test("native cold selection bootstraps, same-identity restart does not spawn discovery", async () => {
  const cold = await entry(historical);
  const warm = await entry({offlineFailure:true}, spark.modelId, "high", cold.out);
  assert.equal(warm.replies.find(x => x.id === "state")?.data?.model?.contextWindow, spark.contextLimit);
  assert.deepEqual(warm.wire, []);
  await writeFile(join(cold.out, "config/muse/auth.json"), "different synthetic login identity");
  const changed = await entry(historical, spark.modelId, "high", cold.out);
  assert.equal(changed.wire.filter(x => x.method === "model/list").length, 1);
  await writeFile(join(cold.out,"cache/pi-muse-tether/catalogue.json"), "{ corrupt fixture");
  const corrupt=await entry(historical,spark.modelId,"high",cold.out);
  assert.equal(corrupt.wire.filter(x=>x.method === "model/list").length,1);
});

test("native Pi agent runs on either provider do not discover; explicit doctor refresh changes rows", async () => {
  const out=await mkdtemp(join(tmpdir(),"muse-catalog-lifecycle-"));
  const agent=join(out,"agent"), catalog=join(out,"catalog.json"), calls=join(out,"calls.jsonl");
  await mkdir(agent);
  await writeFile(join(agent,"settings.json"),JSON.stringify({retry:{enabled:false},compaction:{enabled:false}}));
  await writeFile(catalog,JSON.stringify({...historical,models:[spark]}));
  const child=spawn(process.env.CATALOG_ENTRY_PI ?? join(root,"node_modules/.bin/pi"),[
    "-ne","-ns","-np","-nc","--no-mcp","--no-tools","--mode","rpc","--provider","offline-lifecycle","--model","local",
    "-e",join(here,"catalog-lifecycle-fixture.ts"),
  ],{cwd:out,env:{...process.env,HOME:out,XDG_CACHE_HOME:join(out,"cache"),XDG_CONFIG_HOME:join(out,"config"),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:"1",
    PI_MUSE_TETHER_LIVE:"1",MUSE_NO_AUTO_UPDATE:"1",PI_MUSE_TETHER_BINARY:join(here,"fixtures/catalog-discovery.py"),
    CATALOG_ENTRY_FIXTURE:catalog,CATALOG_ENTRY_CALLS:calls}});
  child.stdin.on("error",()=>{});
  let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);
  const exit=new Promise<number|null>((yes,no)=>{child.once("error",no);child.once("close",yes);});
  const rows=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const send=(value:any)=>child.stdin.write(JSON.stringify(value)+"\n");
  const until=async (pick:(event:any)=>boolean)=>{
    for (;;) {
      const line=await rows.next();if(line.done)throw Error("Pi RPC closed: "+stderr);
      let e;try {e=JSON.parse(line.value);}catch{continue;}
      if(e.type==="response" && !e.success) throw Error(String(e.error));
      if(pick(e))return e;
    }
  };
  const inspect=async()=>{
    send({type:"prompt",id:"inspect",message:"/fixture-models"});
    const result=await until(e=>e.method==="notify" && e.message?.includes("fixtureModels"));
    return JSON.parse(result.message).fixtureModels;
  };
  const discoveries=async()=> (await readFile(calls,"utf8")).trim().split("\n").map(line=>JSON.parse(line)).filter(e=>e.method==="model/list").length;
  try {
    for(const provider of ["offline-lifecycle","pi-muse-tether"]) {
      if(provider==="pi-muse-tether") {
        send({type:"set_model",id:"pick",provider,modelId:spark.modelId});await until(e=>e.id==="pick" && e.type==="response");
      }
      for(const round of [1,2]) {
        send({type:"prompt",id:`${provider}-${round}`,message:"Synthetic lifecycle turn"});
        const event=await until(e=>e.type==="agent_end");
        const last=event.messages.at(-1);
        assert.equal(last.provider,provider);
        assert.equal(last.content[0].text,"SYNTHETIC_LIFECYCLE_OK");
      }
    }
    assert.equal(await discoveries(),1);
    await writeFile(catalog,JSON.stringify({...historical,models:[{...spark,contextLimit:spark.contextLimit+1}]}));
    send({type:"prompt",id:"refresh",message:"/muse-doctor refresh"});
    await until(e=>e.method==="notify" && e.message?.includes('"official catalogue"'));
    assert.ok((await inspect()).some((m:any)=>m[0]===spark.modelId && m[1]===spark.contextLimit+1));
    await writeFile(catalog,JSON.stringify({...historical,models:[]}));
    send({type:"prompt",id:"revoke",message:"/muse-doctor refresh"});
    await until(e=>e.method==="notify" && e.message?.includes('"official catalogue"'));
    assert.deepEqual((await inspect()).map((m:any)=>m[0]),["echo"]);
    assert.equal(await discoveries(),3);
  } finally {child.stdin.end();await exit;}
  assert.equal(await exit,0,stderr);
});

const current = JSON.parse(await readFile(join(here, "fixtures/provider-catalog-window.json"), "utf8"));
// Unverified contributor support: normal registration stays fully dynamic.
current.models.push({...current.models[0], modelId:"muse-ember-1.0", displayLabel:"Muse Ember"});
for (const row of current.models) {
  for (const pickerId of row.modelId === "muse-ember-1.0" ? [row.modelId] : [row.modelId, `${row.modelId}-contributor`])
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
  });
}
