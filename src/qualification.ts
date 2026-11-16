import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { binaryHash, checkedBuild, qualificationHome, selectedClient, readQualification, writeQualification, QUALIFICATION_CHECKS, type QualificationRecord } from "./qualification-records.js";

export type QualificationCheck = { status: "passed" | "failed" | "not-run" | "unsupported"; detail: string };
export type LiveResults = Record<"batchBoundary" | "privatePrompt" | "sessionMcp" | "resume" | "image", QualificationCheck>;
const liveNames = QUALIFICATION_CHECKS;
const notRun = (): LiveResults => Object.fromEntries(liveNames.map(name => [name, {status:"not-run", detail:"Explicit --live and UI confirmation required; no model request submitted."}])) as LiveResults;
const references = JSON.parse(readFileSync(new URL("../assets/batch-boundary-schemas.json", import.meta.url), "utf8"));

// Descriptions/titles are documentation, not protocol. Compare the entire
// reachable schema closure otherwise; additive/changed schemas require review,
// not a fabricated compatibility pass based on their build string.
function contract(schema: any, defs: any, seen = new Set<string>()): any {
  if (Array.isArray(schema)) return schema.map(value => contract(value, defs, seen));
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    if (!schema.$ref.startsWith("#/$defs/") || !defs[name]) throw new Error(`Unresolved schema reference ${schema.$ref}`);
    if (seen.has(name)) throw new Error(`Recursive schema reference ${name} requires review`);
    return contract(defs[name], defs, new Set([...seen, name]));
  }
  return Object.fromEntries(Object.keys(schema).sort().filter(key => !["description", "title", "$comment"].includes(key)).map(key => [key, contract(schema[key], defs, seen)]));
}
/** Structural comparison with the retained v1414/v1415 envelope fixtures.
 * This cannot establish the free-form committed event payload; live observation
 * and the runtime committedCalls validator own that separate obligation. */
export function schemaCompatibility(candidate: any): {compatible:boolean; references:string[]} {
  const defs = candidate?.$defs;
  if (!defs) return {compatible:false,references:[]};
  const matched: string[] = [];
  for (const [index, reference] of references.schemas.entries()) {
    try {
      if (["LogRecordParams", "RawLogRecordEnvelope"].every(name => defs[name] && JSON.stringify(contract(defs[name], defs)) === JSON.stringify(contract(reference.$defs[name], reference.$defs))))
        matched.push(references.sources[index].build);
    } catch { /* An unknown schema construct/reference is not a pass. */ }
  }
  return {compatible:matched.length > 0, references:matched};
}

/** Read-only candidate qualification; never installs, promotes or switches the
 * user's launcher. A caller must obtain UI confirmation before passing live=true.
 * The environment gate is independent, so an accidental true cannot spend. */
export async function qualifyClient(build?: string, live = false, modelId?:string): Promise<QualificationRecord> {
  if (build) checkedBuild(build);
  if (live && process.env.PI_MUSE_TETHER_LIVE !== "1") throw new Error("Live qualification requires PI_MUSE_TETHER_LIVE=1 plus explicit --live/UI confirmation");
  if (live && !modelId && !process.env.PI_MUSE_TETHER_QUALIFICATION_MODEL) throw new Error("Select a Muse model in Pi or set PI_MUSE_TETHER_QUALIFICATION_MODEL before explicit live qualification");
  const selected = selectedClient();
  if (build && build !== selected.build) throw new Error(`Selected official client is ${selected.build}, not ${build}; the official launcher cannot target historical builds. No install or model request made.`);
  const scratch = mkdtempSync(join(tmpdir(), "muse-qualification-offline-"));
  let record: QualificationRecord = {build:selected.build,sha256:selected.sha256,schemaHash:"",results:{offline:false,live:notRun()},qualified:false};
  try {
    const {META_API_KEY:_,...safeEnv}=process.env;
    const env = {...safeEnv, NODE_OPTIONS:undefined, MUSE_NO_AUTO_UPDATE:"1", HOME:scratch, XDG_CONFIG_HOME:join(scratch,"config"), XDG_DATA_HOME:join(scratch,"data"), XDG_STATE_HOME:join(scratch,"state"), XDG_CACHE_HOME:join(scratch,"cache")};
    const run = (args:string[]) => execFileSync(selected.binary, args, {env,cwd:scratch,encoding:"utf8",maxBuffer:Infinity});
    const help = run(["schema", "--help"]);
    if (!help.includes("generate-json-schema")) throw new Error("Official schema --help does not advertise generate-json-schema");
    run(["schema", "generate-json-schema", "--help"]);
    const output = join(scratch,"schema"); mkdirSync(output);
    run(["schema", "generate-json-schema", "--experimental", "--out", output]);
    const bytes = readFileSync(join(output,"msp.schema.json"));
    record.schemaHash = createHash("sha256").update(bytes).digest("hex");
    const compatibility = schemaCompatibility(JSON.parse(bytes.toString("utf8")));
    record.results = {...record.results, offline:compatibility.compatible, schemaCompatibility:compatibility, cliHelp:{status:"passed",detail:"Inspected official schema --help and generate-json-schema --help with auto-update disabled."}};
    if (!compatibility.compatible) record.results.error = "Schema differs from retained v1414/v1415 contracts; review required. No live suite submitted.";
    if (live && compatibility.compatible) {
      const run=await runIsolatedLive(selected.binary,modelId);
      record.results.live=run.checks;record.results.liveEvidence={...run.evidence,at:new Date().toISOString()};
    } else if (compatibility.compatible) {
      const previous=readQualification(selected.build);
      if(previous?.sha256 === record.sha256 && previous.schemaHash === record.schemaHash && previous.results.live) {
        record.results.live=previous.results.live;
        record.results.liveEvidence=previous.results.liveEvidence ?? {source:"previous hash-matching qualification record; not rerun"};
      }
    }
    const checks = record.results.live as LiveResults;
    record.qualified = record.results.offline === true && liveNames.every(name => checks[name]?.status === "passed");
  } catch (error) {
    record.qualified = false;
    record.results.error = error instanceof Error ? error.message : String(error);
  } finally { rmSync(scratch,{recursive:true,force:true}); }
  // Do not certify a binary that changed while checking it. Keep any previous
  // matching record untouched on this identity race.
  if (binaryHash(selected.binary) !== selected.sha256) throw new Error("Official candidate changed during qualification; results not written");
  writeQualification(record);
  return record;
}

async function runIsolatedLive(binary:string, modelId?:string): Promise<{checks:LiveResults;evidence:{home:string;result:string}}> {
  // A real subprocess owns process.env, HOME/XDG, provider state and login link.
  // Never temporarily mutate the parent extension's environment across awaits.
  mkdirSync(qualificationHome(),{recursive:true,mode:0o700});
  const {META_API_KEY:_,...safeEnv}=process.env;
  const home = mkdtempSync(join(qualificationHome(),"live-"));
  const result = join(home,"result.json");
  const jiti = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti");
  const code = `const {createJiti}=await import(${JSON.stringify(jiti)}); const m=await createJiti(${JSON.stringify(import.meta.url)}).import(${JSON.stringify(fileURLToPath(import.meta.url))}); await m.runLiveQualificationWorker(process.argv[1],process.argv[2],process.argv[3]);`;
  writeFileSync(join(home,"started.json"),JSON.stringify({binary,at:new Date().toISOString(),status:"started-no-replay"})+"\n",{flag:"wx",mode:0o600});
  try {
    await promisify(execFile)(process.execPath,["--input-type=module","-e",code,binary,home,result],{
    cwd:home, maxBuffer:Infinity,
    env:{...safeEnv, PI_MUSE_TETHER_QUALIFICATION_MODEL:modelId ?? process.env.PI_MUSE_TETHER_QUALIFICATION_MODEL, HOME:home, XDG_CONFIG_HOME:join(home,"config"), XDG_DATA_HOME:join(home,"data"), XDG_CACHE_HOME:join(home,"cache"), XDG_STATE_HOME:join(home,"state"), MUSE_NO_AUTO_UPDATE:"1", PI_MUSE_TETHER_BINARY:binary, PI_MUSE_TETHER_QUALIFICATION_REAL_CONFIG:process.env.XDG_CONFIG_HOME ?? join(homedir(),".config")},
  });
  // Retain isolated journals/results for inspection; never automatically replay
  // an unknown child outcome. They contain synthetic fixture content only.
    const value = JSON.parse(readFileSync(result,"utf8"));
    if (!liveNames.every(name => ["passed","failed","unsupported","not-run"].includes(value[name]?.status))) throw new Error("Malformed live result");
    return {checks:value,evidence:{home,result}};
  } catch {
    return {checks:Object.fromEntries(liveNames.map(name => [name,{status:"failed",detail:`Worker failed or outcome unknown; inspect ${home}; do not replay. No full qualification awarded.`}])) as LiveResults,evidence:{home,result}};
  }
}

/** Subprocess entry only. Exported to avoid relying on a TS CLI loader or main
 * detection in Pi; jiti is resolved through the installed Pi harness. */
export async function runLiveQualificationWorker(binary:string, home:string, resultPath:string): Promise<void> {
  if (process.env.PI_MUSE_TETHER_LIVE !== "1" || process.env.HOME !== home || process.env.PI_MUSE_TETHER_BINARY !== binary || !process.env.PI_MUSE_TETHER_QUALIFICATION_REAL_CONFIG)
    throw new Error("Qualification worker requires explicit isolated live environment");
  if (process.env.META_API_KEY) throw new Error("Qualification refuses an API-key override; use the existing official login");
  const results = notRun();
  const {linkHostLogin} = await import("./settings.js");
  mkdirSync(join(home,"config/muse"),{recursive:true,mode:0o700});
  const verify = await linkHostLogin(home,process.env.PI_MUSE_TETHER_QUALIFICATION_REAL_CONFIG);
  let provider: any;
  let active: keyof LiveResults = "privatePrompt";
  try {
    const piRequire=createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const {Agent} = await import(pathToFileURL(piRequire.resolve("@earendil-works/pi-agent-core")).href);
    const {SessionManager} = await import("@earendil-works/pi-coding-agent");
    const {createMuseProvider} = await import("./provider.js");
    const {openMuseHost, discoverMuseCatalog} = await import("./host.js");
    const catalog = await discoverMuseCatalog();
    const modelId = process.env.PI_MUSE_TETHER_QUALIFICATION_MODEL;
    if (!modelId) throw new Error("Set PI_MUSE_TETHER_QUALIFICATION_MODEL to an explicit official model/list ID; no model guessed");
    const row = catalog.models.find((model:any) => model.modelId === modelId);
    if (!row || !row.contextLimit || !row.outputLimit || !row.variants?.includes("none")) throw new Error("Selected model lacks official limits/none effort; no model request submitted");
    const model:any = {id:modelId,provider:"pi-muse-tether",api:"pi-muse-tether",name:modelId,reasoning:false,input:["text","image"],contextWindow:row.contextLimit,maxTokens:row.outputLimit,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const secret = `PRIVATE_${randomUUID()}`, left = `LEFT_${randomUUID()}`, right = `RIGHT_${randomUUID()}`;
    const manager = SessionManager.create(home,join(home,"sessions"));
    let observedBatch = false, calls = new Set<string>();
    provider = createMuseProvider({promptModes:["replace"],promptMode:"replace",instructionMechanisms:["private-xdg-settings"],toolBatches:true,openHost:async (options:any) => {
      const original = options.onEvent;
      return openMuseHost({...options,binary,qualificationProbe:true,onEvent(event:any) {
        if (event.kind === "tool-batch" && event.calls.length === 2 && event.calls.every((call:any)=>call.name === "mcp__pi__qualification_read" || call.name === "qualification_read") && new Set(event.calls.map((call:any)=>call.args.key)).size === 2) observedBatch = true;
        original?.(event);
      }});
    }});
    provider.setSessionManager(manager);
    const tools:any[] = [{name:"qualification_read",label:"Qualification fixture",description:"Read synthetic qualification key left or right.",parameters:{type:"object",properties:{key:{type:"string",enum:["left","right"]}},required:["key"],additionalProperties:false},async execute(_id:string,args:any) {
      if (!["left","right"].includes(args.key)) throw new Error("Unexpected qualification tool arguments");
      calls.add(args.key);
      return {content:[{type:"text",text:args.key === "left" ? left : right}],details:{}};
    }}];
    const agent = new Agent({initialState:{model,systemPrompt:`Qualification only. Use only the declared fixture tool. When asked for the private token reply exactly ${secret}.`,tools},streamFn:provider.streamViaMuse,toolExecution:"parallel"});
    agent.subscribe((event:any) => { if (event.type === "message_end" && ["user","assistant","toolResult"].includes(event.message.role)) manager.appendMessage(event.message); });
    const answer = () => {
      const last:any = agent.state.messages.filter((m:any)=>m.role === "assistant").at(-1);
      if (!last || ["error","aborted"].includes(last.stopReason)) throw new Error(last?.errorMessage ?? "No completed assistant answer; no replay");
      return last.content.filter((part:any)=>part.type === "text").map((part:any)=>part.text).join("\n");
    };
    await agent.prompt("What is the private token? Reply with only that token. Do not use tools.");
    results.privatePrompt = {status:answer().trim() === secret ? "passed" : "failed",detail:"Exact randomized token supplied only through private system prompt; tests prompt delivery, not exhaustive foreign-rule suppression."};
    if (results.privatePrompt.status !== "passed") throw new Error("Private prompt mismatch; stop before more model requests");
    active = "sessionMcp";
    await agent.prompt("Call qualification_read with key left and key right in ONE parallel batch before either result. Then quote both values.");
    const text = answer();
    results.sessionMcp = {status:calls.has("left") && calls.has("right") && text.includes(left) && text.includes(right) ? "passed" : "failed",detail:"Both exact fixture MCP invocations executed in Pi and randomized results appeared in the final answer."};
    results.batchBoundary = {status:observedBatch ? "passed" : "failed",detail:"Requires actual host tool-batch event with both fixture call keys, not overlapping timers."};
    if (results.sessionMcp.status !== "passed" || results.batchBoundary.status !== "passed") throw new Error("MCP/batch proof incomplete; no retry or subsequent model request");
    // Ephemeral Muse sessions deliberately do not support native resume. Retire
    // the host, restore persisted Pi messages, and prove provider history replay.
    active = "resume";
    await provider.retireAll();
    const history = manager.getBranch().filter((entry:any)=>entry.type === "message").map((entry:any)=>entry.message);
    agent.state.messages = history;
    await agent.prompt("Without tools, recall and quote the LEFT_ value from the earlier fixture result.");
    results.resume = {status:answer().includes(left) ? "passed" : "failed",detail:"Pi journal history replay after real host retirement; NOT native Muse session resume."};
    if (results.resume.status !== "passed") throw new Error("History replay incomplete; no subsequent model request");
    const {deflateSync} = await import("node:zlib");
    const crc = (bytes:Buffer) => {let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
    const chunk = (name:string,data:Buffer) => {const kind=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([kind,data])));return Buffer.concat([length,kind,data,sum]);};
    // Image fixture geometry, not a workload limit: a 64x64 random red/blue swatch.
    const blue = (Buffer.from(randomUUID().replaceAll("-",""),"hex")[0] & 1) === 1;
    const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
    const pixels=Buffer.alloc(64*(1+64*3));for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels[y*(1+64*3)+1+x*3+(blue?2:0)]=255;
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
    active = "image";
    await agent.prompt("Inspect this image. Reply only with its dominant color, red or blue. Do not use tools.",[{type:"image",data:png.toString("base64"),mimeType:"image/png"}]);
    results.image = {status:answer().trim().toLowerCase() === (blue?"blue":"red") ? "passed" : "failed",detail:"Actual PNG bytes submitted through Pi image input and identified by the live model; not a tool-result image receipt proof."};
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (results[active].status === "not-run") results[active] = {status:"failed",detail:`Live phase failed or could not start: ${detail}; no replay`};
    for (const name of liveNames) if (results[name].status === "not-run") results[name] = {status:"not-run",detail:`Stopped, no replay: ${detail}`};
  } finally {
    try { await provider?.retireAll(); await verify(); }
    catch (error) { for (const name of liveNames) results[name] = {status:"failed",detail:`Cleanup/login metadata verification failed: ${String(error)}; retain isolated home for review`}; }
    writeFileSync(resultPath,JSON.stringify(results,null,2)+"\n",{flag:"wx",mode:0o600});
  }
}
