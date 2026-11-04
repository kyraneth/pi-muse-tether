import {afterEach, describe, expect, it} from "vitest";
import {Connection} from "@muse-code/sdk";
import {Agent} from "@earendil-works/pi-agent-core";
import {createEditTool, createReadTool, SessionManager} from "@earendil-works/pi-coding-agent";
import {validateToolArguments} from "@earendil-works/pi-ai";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MuseHost} from "../src/host.js";
import {createMuseProvider} from "../src/provider.js";
const real=JSON.parse(readFileSync(new URL("./fixtures/invalid-batch.json",import.meta.url),"utf8"));
const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
class Frames {
 values:any[]=[];waiters:any[]=[];
 push(x:any){const v={done:false,value:JSON.stringify(x)+"\n"};const w=this.waiters.shift();w?w(v):this.values.push(v);}
 end(){const v={done:true};const w=this.waiters.shift();w?w(v):this.values.push(v);}
 [Symbol.asyncIterator](){return {next:()=>Promise.resolve(this.values.shift()??new Promise(r=>this.waiters.push(r)))};}
}
let cleanup:undefined|(()=>Promise<void>);
afterEach(async()=>{await cleanup?.();cleanup=undefined;});
async function fixture(mode="normal") {
 const root=await mkdtemp(join(tmpdir(),"muse-invalid-batch-"));
 const path="packages/example/src/scan/sample.ts";
 await mkdir(join(root,"packages/example/src/scan"),{recursive:true});
 await writeFile(join(root,path),Array.from({length:360},(_,i)=>`line ${i+1}`).join("\n"));
 const nativeTools=[createEditTool(root),createReadTool(root)];
 const invalid=real.frames.invalidCommit.params.record.payload.event.tool_calls[0];
 const next=real.frames.nextCommit.params.record.payload.event.tool_calls[0];
 const state:any={commands:[],invocations:[],toolRuns:[],results:[],outputs:[],events:[],readEntered:deferred(),readRelease:deferred(),divergentSeen:deferred()};
 let host:MuseHost,turnId:string,connection:Connection,turnCount=0;
 const children:any[]=[];
 const provider=createMuseProvider({toolBatches:true,openHost:async options=>{
  const frames=new Frames(),decisions=new Map<string,ReturnType<typeof deferred>>();
  let consumed=deferred();
  const approvalId=(id:string)=>turnCount===1?id:`${id}-turn-${turnCount}`;
  const reply=(f:any,result:any)=>frames.push({jsonrpc:"2.0",id:f.id,result});
  const notify=(method:string,params:any)=>frames.push({jsonrpc:"2.0",method,params:{sessionId:"fixture",turnId,sourceRange:{first:{id:method,sequence:1},last:{id:method,sequence:1},stream:{kind:"session",id:"fixture"}},viewCursor:method,...params}});
  const commit=(calls:any[])=>{
   if(mode.startsWith("divergent"))calls=calls.map(c=>c.call_id===invalid.call_id?{...c,args:JSON.stringify({...JSON.parse(c.args),path:"changed-after-refusal"})}:c);
   const original=calls[0].call_id===invalid.call_id?real.frames.invalidCommit:real.frames.nextCommit;
   const f=structuredClone(original);f.params.record.payload.run_id=turnId;f.params.record.payload.event.tool_calls=calls;
   frames.push(f);
  };
  const rejection=()=>{
   const p=structuredClone(real.frames.rejection.params);p.sessionId="fixture";p.item.turnId=turnId;p.item.itemId=approvalId(p.item.itemId);
   if(mode==="wrong-approval")p.item.itemId="foreign-approval";
   if(mode==="wrong-args")p.item.args=JSON.stringify({...JSON.parse(invalid.args),path:"elsewhere"});
   if(mode==="wrong-status")p.item.status="completed";
   if(mode==="wrong-turn")p.item.turnId="foreign-turn";
   if(mode==="wrong-call")p.item.callId="foreign-call";
   if(mode!=="missing-receipt")notify("item/completed",p);
  };
  const approve=async(which:"invalidApproval"|"nextApproval")=>{
   const f=structuredClone(real.frames[which]);const p=f.params;
   p.sessionId="fixture";p.turnId=turnId;p.approvalId=approvalId(p.approvalId);p.currentRequirementId.approvalId=p.approvalId;
   const decision=deferred();decisions.set(p.approvalId,decision);
   frames.push(f);return decision.promise;
  };
  const drive=async()=>{
   // Exercise both rawLog/view orderings. Live fixture approves/refuses before rawLog.
   const mixed=mode.startsWith("mixed"),calls=mode==="mixed-late"?[next,invalid]:[invalid,next];
   if(mode==="commit-first" || mixed)commit(mixed?calls:[invalid]);
   if(mode!=="mixed-late") {
    state.invalidDecision=await approve("invalidApproval");
    if(mode==="receipt-first")rejection();
    if(mode!=="commit-first" && !mixed && mode!=="divergent-buffered")commit([invalid]);
    if(mode!=="receipt-first")rejection();
   }
   if(mode!=="divergent-buffered")commit(mixed?calls:[invalid]); // Retry/recommit must not execute again.
   if(mode==="overlap") {
    // An unrelated valid batch is still outstanding: another new valid commit is not repair.
    commit([next]);commit([{...next,call_id:"genuinely-overlapping"}]);return;
   }
   if(!mixed)commit([next]);
   if(["wrong-approval","wrong-args","wrong-status","wrong-turn","wrong-call","missing-receipt","divergent-commit"].includes(mode)) {
    notify("turn/completed",{terminal:"completed"});return;
   }
   const allowed=await approve("nextApproval");
   if(allowed!=="allow_once") {notify("turn/completed",{terminal:"completed"});return;}
   const d=options.mcpServers!.pi as any;
   const child=spawn(d.command,d.args,{env:{...process.env,...d.env},stdio:["pipe","pipe","pipe"]});children.push(child);child.stderr.resume();
   createInterface({input:child.stdout}).on("line",line=>{
    const f=JSON.parse(line);if(f.id!==next.call_id)return;
    state.results.push(f.result);if(!f.result){host.fence("Fixture MCP returned no result");return;}
    const text=f.result.content[0].text;state.stored=text;
    notify("item/completed",{item:{...(mode==="divergent-buffered"?{outputRef:{id:"stored-read",availability:"available",byteLen:Buffer.byteLength(text),mediaType:"text/plain"}}:{}),kind:"toolCall",tool:next.name,args:next.args,callId:next.call_id,itemId:"valid-read",revision:2,turnId,
     status:f.result.isError?"failed":"completed",...(f.result.isError?{failureReason:text,visibleOutput:`tool failed: ${text}`}:{visibleOutput:text})}});
    consumed.resolve();
   });
   const args=JSON.parse(next.args);state.invocations.push({name:"read",args});
   child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:next.call_id,method:"tools/call",params:{name:"read",arguments:args,_meta:{callId:next.call_id}}})+"\n");
   await consumed.promise;
   if(mode==="divergent-buffered") {
    await state.readEntered.promise;commit([invalid]);await state.divergentSeen.promise;state.readRelease.resolve();
    notify("turn/completed",{terminal:"completed"});return;
   }
   if(mode==="mixed-late") {state.invalidDecision=await approve("invalidApproval");rejection();}
   if(mixed)commit(calls);else {commit([invalid]);commit([next]);} // Exact recommits remain one-shot.
   notify("turn/completed",{terminal:"completed"});
  };
  connection=new Connection({incoming:frames,async write(chunk:string){
   const f=JSON.parse(chunk),p=f.params??{};state.commands.push(f);
   if(f.method==="session/start")reply(f,{session:{sessionId:"fixture"},viewCursor:"0"});
   else if(f.method==="log/streams")reply(f,{streams:[{stream:{kind:"session.live",id:"fixture"}}]});
   else if(f.method==="log/subscribe")reply(f,{subscriptionId:1});
   else if(f.method==="item/readOutput") {
    state.readEntered.resolve();await state.readRelease.promise;
    reply(f,{byteLen:Buffer.byteLength(state.stored),content:state.stored,encoding:"utf8",eof:true,mediaType:"text/plain",offsetBytes:0});
   }
   else if(f.method==="approval/decide") {reply(f,{commandId:p.commandId,status:"accepted",terminal:false});decisions.get(p.approvalId)?.resolve(p.choiceId);}
   else if(f.method==="turn/cancel") {reply(f,{commandId:p.commandId,status:"accepted"});notify("turn/completed",{terminal:"cancelled"});}
   else if(f.method==="turn/start") {
    turnCount++;consumed=deferred();
    turnId=p.commandId;reply(f,{commandId:p.commandId,status:"accepted",disposition:"started",turnId,startedNewTurn:true});
    notify("turn/started",{commandId:p.commandId});
    void drive().catch(error=>{if(!host.fencedReason)host.fence(`Fixture: ${error.message}`);});
   }
  },close(){frames.end();}});
  host=new MuseHost(connection,{sessionDurability:"ephemeral",grantedCapabilities:["sessionMcp","rawLog"]} as any,{...options,onEvent:event=>{state.events.push(event);options.onEvent?.(event);if(event.kind==="tool-batch" && event.calls.some(c=>c.callId===invalid.call_id))state.divergentSeen.resolve();}},async()=>{
   for(const d of decisions.values())d.resolve("abort");consumed.resolve();state.readRelease.resolve();state.readEntered.resolve();state.divergentSeen.resolve();
   for(const child of children){const exit=new Promise(r=>child.once("exit",r));child.stdin.end();if(child.exitCode===null)await exit;}
   await connection.close();
  });
  state.host=host;return host.open();
 }});
 const manager=SessionManager.create(root,root);provider.setSessionManager(manager);
 const agent=new Agent({initialState:{model:{id:"echo",provider:"pi-muse-tether"} as any,tools:nativeTools.map(tool=>({...tool,async execute(id:string,args:any,...rest:any[]){
  state.toolRuns.push({name:tool.name,args});
  if(mode==="error")throw new Error("offline read failure");
  const result=await (tool.execute as any)(id,args,...rest);state.outputs.push(result);return result;
 }}))},streamFn:provider.streamViaMuse});
 agent.subscribe(e=>{if(e.type==="message_end")manager.appendMessage(e.message as any);});
 cleanup=async()=>{await provider.retireAll();await rm(root,{recursive:true,force:true});};
 state.agent=agent;state.run=()=>agent.prompt({role:"user",content:"Offline synthetic fixture repair",timestamp:1});
 state.invalid=invalid;state.nativeTools=nativeTools;return state;
}
describe("fixture invalid committed spec, real SDK + Pi tools + MCP, offline",()=>{
 it("actual Pi edit schema rejects the fixture string edits; does not eval the expression",async()=>{
  const f=await fixture();
  expect(typeof JSON.parse(f.invalid.args).edits).toBe("string");
  expect(()=>validateToolArguments(f.nativeTools[0],{type:"toolCall",id:f.invalid.call_id,name:"edit",arguments:JSON.parse(f.invalid.args)})).toThrow(/edits.0: expected object, got string/);
 });
 it.each(["normal","commit-first","receipt-first","mixed","mixed-late","error"])("native rejection settles without a Pi edit result; valid read once: %s",async mode=>{
  const f=await fixture(mode);await f.run();
  expect(f.host.fencedReason).toBeUndefined();
  expect(f.agent.state.messages.at(-1).errorMessage).toBeUndefined();
  expect(f.invalidDecision).toBe("abort");
  expect(f.toolRuns).toEqual([{name:"read",args:{limit:20,offset:333,path:"packages/example/src/scan/sample.ts"}}]);
  expect(f.invocations).toEqual(f.toolRuns);
  const results=f.agent.state.messages.filter((m:any)=>m.role==="toolResult");
  expect(results).toHaveLength(1);expect(results[0].toolName).toBe("read");
  expect(f.results).toHaveLength(1);
  expect(f.results[0].content).toEqual(results[0].content);
  expect(f.results[0].isError).toBe(mode==="error");
  if(mode==="error")expect(results[0].content[0].text).toBe("offline read failure");
  else expect(results[0].content).toEqual(f.outputs[0].content);
  expect(f.agent.state.messages.at(-1).stopReason).toBe("stop");
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
  const {flushMuseLedger,museLedgerPath}=await import("../src/request-ledger.js");await flushMuseLedger();
  const ledger=readFileSync(museLedgerPath(),"utf8").trim().split("\n").map(l=>JSON.parse(l));
  const settled=ledger.filter((r:any)=>r.processId===f.host.ledger.processId&&r.type==="tool_schema_refusal_settled");
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({callId:f.invalid.call_id,approvalId:real.frames.invalidApproval.params.approvalId,piExecuted:false,failureKind:"approval_denied",failureReason:"approval aborted"});
 });
 it.each(["divergent-commit","divergent-buffered"])("refusal/commit divergence fences with its exact reason, including readback replay: %s",async mode=>{
  const f=await fixture(mode);await f.run();
  expect(f.host.fencedReason).toBe("Muse schema refusal differs from committed tool batch");
  expect(f.agent.state.messages.at(-1).stopReason).toBe("error");
  expect(f.toolRuns.map((r:any)=>r.name)).toEqual(mode==="divergent-buffered"?["read"]:[]);
 });
 it("reused call IDs in a new user turn do not inherit the old native refusal",async()=>{
  const f=await fixture();await f.run();await f.run();
  expect(f.agent.state.messages.at(-1).stopReason).toBe("stop");
  expect(f.toolRuns.map((r:any)=>r.name)).toEqual(["read","read"]);
  expect(f.results).toHaveLength(2);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(2);
 });
 it.each(["wrong-approval","wrong-args","wrong-status","wrong-turn","wrong-call","missing-receipt","overlap"])("does not settle unknown/mismatched rejection or real overlap: %s",async mode=>{
  const f=await fixture(mode);await f.run();
  expect(f.agent.state.messages.at(-1).stopReason).toBe("error");
  expect(f.agent.state.messages.at(-1).errorMessage).toMatch(/schema refusal receipt|overlapping committed tool batch/);
  expect(f.invocations).toEqual([]);
  expect(f.toolRuns.map((r:any)=>r.name)).toEqual(mode==="overlap"?["read"]:[]);
 });
});
