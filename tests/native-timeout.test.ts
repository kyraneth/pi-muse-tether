import {afterEach,expect,it,vi} from "vitest";
import * as bridgeModule from "pi-tether-core/mcp/bridge";
import {Connection} from "@muse-code/sdk";
import {Agent} from "@earendil-works/pi-agent-core";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {readFileSync} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {MuseHost} from "../src/host.js";
import {createMuseProvider} from "../src/provider.js";
const real=JSON.parse(readFileSync(new URL("./fixtures/native-timeout.json",import.meta.url),"utf8"));
const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
class Frames {
 values:any[]=[];waiters:any[]=[];
 push(x:any){const v={done:false,value:JSON.stringify(x)+"\n"};const w=this.waiters.shift();w?w(v):this.values.push(v);}
 end(){const v={done:true};const w=this.waiters.shift();w?w(v):this.values.push(v);}
 [Symbol.asyncIterator](){return {next:()=>Promise.resolve(this.values.shift()??new Promise(r=>this.waiters.push(r)))};}
}
let cleanup:undefined|(()=>Promise<void>);
afterEach(async()=>{await cleanup?.();cleanup=undefined;vi.restoreAllMocks();});
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"fixture-timeout-"));
 const state:any={runs:[],commands:[],events:[],results:[],toolStarted:deferred(),toolRelease:deferred(),fenced:deferred()};
 state.invoked=deferred();
 const realBridge=bridgeModule.createMcpBridge;
 vi.spyOn(bridgeModule,"createMcpBridge").mockImplementation(options=>realBridge({...options,onInvocation(inv){options.onInvocation(inv);state.invoked.resolve();}}));
 const incoming=new Frames();let host:MuseHost,connection:Connection,child:any,turnId:string;
 const commitCall=real.frames.commit.params.record.payload.event.tool_calls[0];
 const emit=(name:string)=>{
  const f=structuredClone(real.frames[name]);
  if(f.params.sessionId)f.params.sessionId="fixture";
  if(f.params.turnId)f.params.turnId=turnId;
  if(f.params.item?.turnId)f.params.item.turnId=turnId;
  if(f.params.record?.payload?.run_id) {
   f.params.record.payload.run_id=turnId;
   // Older anonymization nested envelope metadata inside payload. Project it
   // only in this fixture so the native batch lifecycle remains exercised.
   for(const key of ["payload_schema_version","payload_type","record_type","recorded_at","schema_version","sequence","stream"])f.params.record[key]??=f.params.record.payload[key];
  }
  incoming.push(f);
 };
 // Real Muse (retained recorded wire) answers a timed-out call with a
 // tool_result_batch_committed carrying the timeout; the host ignores that
 // event kind and the turn continues. Reuse the fixture frame bytes with
 // that event kind instead of the simplified empty-commit frames, which are
 // not the wire shape a surviving turn sees.
 const emitConsumed=()=>{
  const f=structuredClone(real.frames.nativeResult);
  f.params.record.payload.run_id=turnId;
  const ev=f.params.record.payload.event;
  ev.kind="tool_result_batch_committed";
  delete ev.message_id;delete ev.response_id;
  ev.batch_id="fixture-timeout-batch";
  ev.results=[{tool_call_id:real.frames.commit.params.record.payload.event.tool_calls[0].call_id,tool_call_index:0,text:"tool timed out",estimated_prompt_tokens:1}];
  incoming.push(f);
 };
 const provider=createMuseProvider({toolBatches:true,openHost:async options=>{
  const reply=(f:any,result:any)=>incoming.push({jsonrpc:"2.0",id:f.id,result});
  connection=new Connection({incoming,async write(chunk:string){
   const f=JSON.parse(chunk),p=f.params??{};state.commands.push(f);
      // Real 1.4.14 answers the 1.4.15 session-MCP inventory query methodNotFound.
      if (f.method === "mcpServer/readInventory") { incoming.push({jsonrpc:"2.0",id:f.id,error:{code:-32601,message:"method not found",data:{kind:"methodNotFound",retryable:false}}}); return; }
   if(f.method==="session/start")reply(f,{session:{sessionId:"fixture"},viewCursor:"0"});
   else if(f.method==="log/streams")reply(f,{streams:[{stream:{kind:"session.live",id:"fixture"}}]});
   else if(f.method==="log/subscribe")reply(f,{subscriptionId:1});
   else if(f.method==="approval/decide") {
    reply(f,{commandId:p.commandId,status:"accepted",terminal:false});
    if(p.choiceId!=="allow_once")return;
    const d=options.mcpServers!.pi as any;
    child=spawn(d.command,d.args,{env:{...process.env,...d.env},stdio:["pipe","pipe","pipe"]});child.stderr.resume();
    createInterface({input:child.stdout}).on("line",line=>{const r=JSON.parse(line);if(r.id===commitCall.call_id)state.results.push(r);});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:commitCall.call_id,method:"tools/call",params:{name:"bash",arguments:JSON.parse(commitCall.args),_meta:{callId:commitCall.call_id}}})+"\n");
   }
   else if(f.method==="turn/start") {
    turnId=p.commandId;reply(f,{commandId:p.commandId,status:"accepted",disposition:"started",turnId,startedNewTurn:true});
    incoming.push({jsonrpc:"2.0",method:"turn/started",params:{sessionId:"fixture",turnId,commandId:p.commandId}});
    emit("approval");emit("commit");emit("started");
   }
   else if(f.method==="turn/cancel")reply(f,{commandId:p.commandId,status:"accepted"});
  },close(){incoming.end();}});
  // Deliberately exercise the timeout backstop without the new approval hold.
  host=new MuseHost(connection,{sessionDurability:"ephemeral",grantedCapabilities:["sessionMcp","rawLog"]} as any,{...options,waitForPiToolResult:undefined,onEvent:e=>{state.events.push(e);options.onEvent?.(e);if(e.kind==="fenced")state.fenced.resolve();}},async()=>{
   if(child){const exit=new Promise(r=>child.once("exit",r));child.stdin.end();if(child.exitCode===null)await exit;}
   await connection.close();
  });
  return host.open();
 }});
 const manager=SessionManager.create(root,root);provider.setSessionManager(manager);
 const agent=new Agent({initialState:{model:{id:"echo",provider:"pi-muse-tether"} as any,tools:[{name:"bash",label:"Offline Pi bash fixture (never runs a shell)",description:"Synthetic fixture tool ownership",parameters:{type:"object",properties:{command:{type:"string"},timeout:{type:"number"}},required:["command"]},async execute(_id:string,args:any){state.runs.push(args);state.toolStarted.resolve();await state.toolRelease.promise;return {content:[{type:"text" as const,text:"local Pi result after root intervention"}],details:{}};}}]},streamFn:provider.streamViaMuse});
 agent.subscribe(e=>{if(e.type==="message_end")manager.appendMessage(e.message as any);});
 cleanup=async()=>{state.toolRelease.resolve();await provider.retireAll();await agent.waitForIdle();await rm(root,{recursive:true,force:true});};
 return {state,agent,provider,emit,emitConsumed,get host(){return host;}};
}
it("fixture native timeout settles only that call; Pi continues and finishes the turn",async()=>{
 const f=await fixture();const run=f.agent.prompt({role:"user",content:"Offline fixture",timestamp:1});
 await f.state.toolStarted.promise;await f.state.invoked.promise;
 f.emit("timedOut");
 // Let host ingress process the frame; the timeout must not fence anything.
 await new Promise<void>(r=>setImmediate(r));await new Promise<void>(r=>setImmediate(r));
 expect(f.host.fencedReason).toBeUndefined();
 expect(f.host.batches).toBe(true);
 f.emitConsumed();f.emit("terminal");
 f.state.toolRelease.resolve();await run;
 const last:any=f.agent.state.messages.at(-1);
 expect(last.stopReason).toBe("stop");
 expect(f.host.fencedReason).toBeUndefined();
 expect(f.state.runs).toEqual([JSON.parse(real.frames.commit.params.record.payload.event.tool_calls[0].args)]);
 expect(f.agent.state.messages.filter((m:any)=>m.role==="toolResult")).toHaveLength(1);
 expect(f.state.runs).toHaveLength(1);
 expect(f.state.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 // Pi's late result stays in what Pi journaled; it is never replayed to Muse.
 expect(f.state.results.some((r:any)=>r.result?.content?.[0]?.text==="local Pi result after root intervention")).toBe(false);
 const {flushMuseLedger,museLedgerPath}=await import("../src/request-ledger.js");await flushMuseLedger();
 const ledger=readFileSync(museLedgerPath(),"utf8").trim().split("\n").map(l=>JSON.parse(l));
 expect(ledger.find((r:any)=>r.processId===f.host.ledger.processId && r.type==="tool_execution_divergence")).toMatchObject({tool:"mcp__pi__bash",status:"timedOut",piResultJournaled:false,pendingMcp:true});
 expect(ledger.find((r:any)=>r.processId===f.host.ledger.processId && r.type==="tool_native_timeout_consumed")).toMatchObject({tool:"mcp__pi__bash",deliveredToMcp:false,exactModelConsumption:false});
 expect(ledger.some((r:any)=>r.processId===f.host.ledger.processId && r.type==="retire" && r.reason==="fenced" && r.cause==="Muse native tool timeout")).toBe(false);
});
