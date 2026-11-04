import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Connection} from "@muse-code/sdk";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {readFileSync} from "node:fs";
const vendorRetry=JSON.parse(readFileSync(new URL("./fixtures/vendor-retry.json",import.meta.url),"utf8"));
const realErrors=JSON.parse(readFileSync(new URL("./fixtures/tool-errors.json",import.meta.url),"utf8"));
const multipartCaptures=["multipart-text.json","multipart-image.json"].map(name=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),"utf8")));

const deferred=()=>{let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
const tools=[{name:"lookup",description:"Fixture-owned lookup",parameters:{type:"object",properties:{key:{type:"string"}},required:["key"],additionalProperties:false}}];
const model={id:"echo",provider:"pi-muse-tether"};
const user={role:"user",content:"Synthetic tool request",timestamp:1};
let dispose:(()=>Promise<any>)|undefined;
beforeEach(()=>vi.resetModules());
afterEach(async()=>{await dispose?.();dispose=undefined;vi.restoreAllMocks();});
class Frames {
 values:any[]=[];waiters:any[]=[];
 push(x:any){const v={done:false,value:JSON.stringify(x)+"\n"};const w=this.waiters.shift();w?w(v):this.values.push(v);}
 end(){const v={done:true};const w=this.waiters.shift();w?w(v):this.values.push(v);}
 [Symbol.asyncIterator](){return {next:()=>Promise.resolve(this.values.shift()??new Promise(r=>this.waiters.push(r)))};}
}
async function fixture(mode="parallel") {
 const {MuseHost}=await import("../src/host.js");
 const {createMuseProvider}=await import("../src/provider.js");
 const started=deferred(),textSeen=deferred(),firstCall=deferred(),release=deferred(),approval=deferred(),closed=deferred(),receipts=deferred(),held=deferred(),decided=deferred();
 const state:any={commands:[],events:[],opens:0,children:[],pending:[],entries:[],toolRuns:[],started,textSeen,firstCall,release,approval,closed,receipts,held,decided};
 let host:any, send:any;
 const provider=createMuseProvider({toolBatches:mode!=="no-batch",openHost:async(options:any)=>{
  state.opens++;
  // Preserve the historical MCP-before-log compatibility seam explicitly;
  // that fixture deliberately withholds its log until MCP, unlike a live log.
  const wait=mode==="concurrent" ? undefined : options.waitForPiToolResult;
  options.waitForPiToolResult=(request:any)=>{const result=wait?.(request);if(result)held.resolve();return result;};
  const frames=new Frames(),decisions=new Map<string,ReturnType<typeof deferred>>();let turnId:string;
  const notify=(method:string,params:any)=>frames.push({jsonrpc:"2.0",method,params:{sessionId:"fixture",sourceRange:{first:{id:method,sequence:1},last:{id:method,sequence:1},stream:{id:"fixture",kind:"session"}},viewCursor:method,...params}});
  send=notify;
  const reply=(f:any,result:any)=>frames.push({jsonrpc:"2.0",id:f.id,result});
  const connection=new Connection({incoming:frames,async write(chunk:string){
   const f=JSON.parse(chunk),p=f.params??{};state.commands.push(f);
   if(f.method==="session/start")reply(f,{session:{sessionId:"fixture"},viewCursor:"0"});
   else if(f.method==="log/streams")reply(f,{streams:[{stream:{kind:"session.live",id:"fixture"}}]});
   else if(f.method==="log/subscribe")reply(f,{subscriptionId:1});
   else if(f.method==="item/readOutput") {
    state.readEntered?.resolve();
    if(state.readGate)await state.readGate.promise;
    const bytes=Buffer.from(state.stored),offset=p.offsetBytes;
    const content=bytes.subarray(offset).toString("utf8");
    reply(f,state.mutatePage?.({byteLen:Buffer.byteLength(content),content,encoding:"utf8",eof:true,mediaType:"text/plain",offsetBytes:offset})??{byteLen:Buffer.byteLength(content),content,encoding:"utf8",eof:true,mediaType:"text/plain",offsetBytes:offset});
   }
   else if(f.method==="approval/decide"){
    decided.resolve();
    reply(f,{commandId:p.commandId,status:"accepted",terminal:false});
    decisions.get(p.approvalId)?.resolve(p.choiceId);
   }
   else if(f.method==="turn/cancel") {reply(f,{commandId:p.commandId,status:"accepted"});notify("turn/completed",{turnId,terminal:"cancelled"});}
   else if(f.method==="turn/steer") {
    reply(f,{commandId:p.commandId,status:"accepted",turnId});
    notify("item/started",{turnId,item:{kind:"userMessage",commandId:p.commandId,steered:true,itemId:"steer",revision:1,status:"completed",text:p.input[0].text}});
    notify("turn/completed",{turnId,terminal:"completed"});
   }
   else if(f.method==="turn/start"){
    turnId=p.commandId;
    if(mode==="admission-denied"){
      frames.push({jsonrpc:"2.0",id:f.id,error:{code:-32000,message:"Account refused",data:{kind:"providerError",httpStatus:403,retryable:false}}});return;
    }
    if(mode==="admission-retry"){
      frames.push({jsonrpc:"2.0",id:f.id,error:{code:-32001,message:"Server temporarily busy",data:{kind:"overloaded",retryable:true}}});return;
    }
    reply(f,{commandId:p.commandId,status:"accepted",disposition:"started",turnId,startedNewTurn:true});
    notify("turn/started",{turnId,commandId:p.commandId});started.resolve();
    if(mode==="death")queueMicrotask(()=>host.hostExited({kind:"transportEof"}));
    else if(mode.startsWith("retry"))queueMicrotask(()=>{
     notify(state.retryMethod??"turn/modelRetryScheduled",{...vendorRetry.retry.params,sessionId:"fixture",turnId,...state.retryMutation});
     if(mode==="retry-complete")notify("turn/completed",{turnId,terminal:"completed"});
     if(mode==="retry-fail-no-status")notify("turn/modelRetryScheduled",{...vendorRetry.retry.params,sessionId:"fixture",turnId,httpStatus:undefined,errorKind:"transient"});
     if(mode.startsWith("retry-fail"))notify("turn/completed",{turnId,terminal:"failed",error:{kind:"modelError",message:"Attempts exhausted",retryable:true}});
    });
    else if(mode==="stream"){
     notify("item/delta",{turnId,itemId:"text",field:"text",delta:"Partial truthful text"});
     if(state.commands.filter((x:any)=>x.method==="turn/start").length>1)notify("turn/completed",{turnId,terminal:"completed"});
    }
    else if(["parallel","concurrent","tool","approval","no-batch","tool-errors","next-batch","vendor-tools"].includes(mode))void (async()=>{
     if(mode==="approval"){approval.resolve();await release.promise;if(options.signal.aborted)return;}
     const names=mode==="tool-errors"?["a","b","c","d"]:["parallel","concurrent","next-batch","vendor-tools"].includes(mode)?["a","b"]:["a"];
     const consumed=new Map(names.map(id=>[id,deferred()]));
     const commit=(ids=names)=>frames.push({jsonrpc:"2.0",method:"log/record",params:{subscriptionId:1,record:{payload:{kind:"run",run_id:turnId,event:{kind:"assistant_tool_calls_committed",tool_calls:ids.map(id=>({call_id:id,name:"mcp__pi__lookup",args:JSON.stringify({key:id})}))}}}}});
     if(mode!=="concurrent"&&mode!=="no-batch")commit(mode==="next-batch"?["a"]:names);
     if(mode==="vendor-tools") {
      notify("turn/modelRetryScheduled",{...vendorRetry.retry.params,sessionId:"fixture",turnId});
      commit(); // Recommit while Pi still owns this batch.
     }
     const d=options.mcpServers.pi;
     const child=spawn(d.command,d.args,{env:{...process.env,...d.env},stdio:["pipe","pipe","pipe"]});state.children.push(child);child.stderr.resume();
     createInterface({input:child.stdout}).on("line",line=>{
      const f=JSON.parse(line);if(!f.result)return;
      state.events.push(`receipt-${f.id}`);
      state.mcpResults??=[];state.mcpResults.push(f.result);
      const text=f.result.content[0].text;
      const item=f.result.isError ? {...realErrors.frames[0].frame.params.item,tool:"mcp__pi__lookup",args:JSON.stringify({key:f.id}),callId:f.id,itemId:f.id,turnId,failureReason:text,visibleOutput:`tool failed: ${text}`} : {kind:"toolCall",tool:"mcp__pi__lookup",callId:f.id,itemId:f.id,revision:2,status:"completed",visibleOutput:state.capturedOutput??text};
      notify("item/completed",{turnId,item:state.mutateReceipt?.(item)??item});
      state.pending.push(f.id);consumed.get(f.id)!.resolve();
      if(state.pending.length===names.length){
       if(mode==="vendor-tools")commit(); // Recommit again after verified receipts.
       receipts.resolve();if(!state.steering)notify("turn/completed",{turnId,terminal:"completed"});
      }
     });
     for(const id of names){
      if(options.signal.aborted)return;
      if(mode==="next-batch"&&id==="b"){commit(["b"]);state.nextApproval?.resolve();}
      state.events.push(`approval-${id}`);
      const request={toolName:"mcp__pi__lookup",toolCallId:id,rawArgs:JSON.stringify({key:id}),approvalId:`approval-${id}`,currentRequirementId:{approvalId:`approval-${id}`,sourceIndex:0}};
      const decision=deferred();decisions.set(request.approvalId,decision);
      frames.push({jsonrpc:"2.0",id:id==="a"?201:202,method:"approval/request",params:{...request,sessionId:"fixture",turnId,itemId:id,taskId:"task",subject:{kind:"tool",toolName:request.toolName},sourceRange:{},viewCursor:`approval-${id}`,judgeEscalated:false,protectedWrite:false,availableChoices:[{choiceId:"allow_once",decision:"approved",scope:"once",label:"Allow once"},{choiceId:"deny",decision:"denied",scope:"once",label:"Deny"}]}});
      if(await decision.promise!=="allow_once")throw new Error("Fixture approval rejected");
      state.events.push(`approved-${id}`);
      if(state.beforeMcp){state.decisionReached.resolve();await state.beforeMcp.promise;if(options.signal.aborted)return;}
      // Real client order: approval, invocation, result, next approval.
      // Concurrent mode retains the previously qualified invocation-before-log race.
      notify("item/started",{turnId,item:{kind:"toolCall",tool:"mcp__pi__lookup",callId:id,itemId:id,revision:1,status:"inProgress"}});
      child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name:"lookup",arguments:{key:id==="b"&&state.mismatch?"changed":id},_meta:{callId:id}}})+"\n");
      if(id==="a")await firstCall.promise;
      if(mode!=="concurrent")await consumed.get(id)!.promise;
      if(id==="a"&&state.beforeNext){state.betweenCalls.resolve();await state.beforeNext.promise;}
     }
     if(mode==="concurrent")commit();
    })().catch(error=>host.fence(String(error)));
   }
  },close(){frames.end();}});
  const original=options.onEvent;
  host=new MuseHost(connection,{sessionDurability:"ephemeral",grantedCapabilities:["sessionMcp","rawLog"]} as any,{...options,onEvent:(e:any)=>{state.events.push(e.kind);original(e);if(e.kind==="terminal")state.terminalSeen?.resolve();if(e.kind==="fenced" || e.kind==="frame"&&["turn/retryScheduled","turn/modelRetryScheduled"].includes(e.frame.method))state.retrySeen?.resolve();if(e.kind==="frame"&&e.frame.method==="item/delta")textSeen.resolve();}},async()=>{
   for(const c of state.children){const exit=new Promise(r=>c.once("exit",r));c.stdin.end();if(c.exitCode===null)await exit;}
   await connection.close();closed.resolve();
  });
  const record=host.ledger.record.bind(host.ledger);state.ledgerRecords=[];
  vi.spyOn(host.ledger,"record").mockImplementation((type:any,fields:any)=>{state.ledgerRecords.push({type,...fields});record(type,fields);});
  state.host=host;state.send=(method:string,p:any)=>notify(method,{turnId,...p});
  return host.open();
 }});
 // Observe the REAL broker's callback without replacing it: firstCall opens
 // only when an MCP invocation crossed the socket. This is no timing heuristic.
 const core=await import("pi-tether-core/mcp/bridge");
 const realBridge=core.createMcpBridge;
 vi.spyOn(core,"createMcpBridge").mockImplementation(options=>realBridge({...options,onInvocation(inv){state.events.push(`invoke-${(inv.metadata as any)?.callId}`);firstCall.resolve();options.onInvocation(inv);}}));
 provider.setSessionManager({getSessionId:()=>`tool-lifecycle-${mode}`,getSessionFile:()=>"fixture.jsonl",getBranch:()=>state.entries});
 state.provider=provider;state.context=(messages:any[])=>({messages,tools});
 state.result=(call:any)=>({role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:`Pi-${call.arguments.key}`}],isError:false,timestamp:2});
 dispose=async()=>{release.resolve();state.beforeMcp?.resolve();await provider.retireAll();};
 return state;
}

async function native(f:any, execute?:any, beforeToolCall?:any){
 const {Agent}=await import("@earendil-works/pi-agent-core");
 const {SessionManager}=await import("@earendil-works/pi-coding-agent");
 const dir=await mkdtemp(join(tmpdir(),"muse-tool-journal-"));
 f.manager=SessionManager.create(dir,dir);
 f.provider.setSessionManager(f.manager);
 const agent=new Agent({initialState:{model:model as any,tools:[{...tools[0],label:"Fixture lookup",execute:execute??(async(_id:string,args:any)=>{f.toolRuns.push(args.key);return {content:[{type:"text",text:`Pi-${args.key}`}],details:{}};})}]},streamFn:f.provider.streamViaMuse,beforeToolCall,toolExecution:"parallel"});
 agent.subscribe(event=>{if(event.type==="message_end")f.manager.appendMessage(event.message);});
 return agent;
}

describe("real SDK + real MCP broker on synthetic fixtures, offline",()=>{
 it.each([false,true])("holds official approvals until the complete Pi batch is journaled, then sequential MCP answers exactly once (error=%s)",async error=>{
  const f=await fixture(),entered=deferred(),release=f.release;
  const agent=await native(f,async(_id:string,args:any)=>{
   f.toolRuns.push(args.key);if(f.toolRuns.length===2)entered.resolve();
   await release.promise;
   if(error && args.key==="b")throw new Error("offline Pi failure");
   return {content:[{type:"text",text:`Pi-${args.key}`}],details:{}};
  });
  const run=agent.prompt(user as any);await entered.promise;await Promise.race([f.held.promise,f.decided.promise]);
  expect(f.commands.filter((c:any)=>c.method==="approval/decide")).toHaveLength(0);
  expect(f.events.some((e:any)=>String(e).startsWith("invoke-"))).toBe(false);
  release.resolve();await run;
  expect(f.toolRuns).toEqual(["a","b"]);expect(f.pending).toEqual(["a","b"]);
  expect(f.mcpResults.map((r:any)=>r.isError)).toEqual([false,error]);
  expect(f.commands.filter((c:any)=>c.method==="approval/decide")).toHaveLength(2);
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
  const entries=f.manager.getBranch();
  expect(entries.filter((e:any)=>e.message?.role==="toolResult")).toHaveLength(2);
 });
 it.each(["timedOut","rejected","turn-abandoned","host-death","approval-resolved","stage-changed"])("native %s during an official approval hold fences without MCP dispatch or replay",async outcome=>{
  const f=await fixture("tool"),entered=deferred(),release=f.release;
  const agent=await native(f,async()=>{f.toolRuns.push("a");entered.resolve();await release.promise;return {content:[{type:"text",text:"Pi-a"}],details:{}};});
  const run=agent.prompt(user as any);await entered.promise;await f.held.promise;
  expect(f.commands.filter((c:any)=>c.method==="approval/decide")).toHaveLength(0);
  if(outcome==="host-death")f.host.hostExited({kind:"transportEof"});
  else if(outcome==="turn-abandoned")f.send("turn/completed",{terminal:"cancelled"});
  else if(outcome==="approval-resolved")f.send("approval/resolved",{approvalId:"approval-a",itemId:"a",decision:"abort",decidedAt:"2026-11-03T00:00:00Z",decidedByCommandId:null,policyResult:"deny",resolvedBy:"user"});
  else if(outcome==="stage-changed")f.send("approval/updated",{approvalId:"approval-a",currentRequirementId:{approvalId:"approval-a",sourceIndex:1},change:{kind:"stageResolved"},subject:{kind:"tool",toolName:"mcp__pi__lookup"},availableChoices:[{choiceId:"allow_once",decision:"approved",scope:"once",label:"Allow once"},{choiceId:"deny",decision:"denied",scope:"once",label:"Deny"}]});
  else f.send("item/completed",{item:{kind:"toolCall",tool:"mcp__pi__lookup",callId:"a",itemId:"a",revision:2,status:outcome,...(outcome==="rejected"?{failureKind:"approval_denied",failureReason:"approval aborted"}:{visibleOutput:"tool timed out"})}});
  // Connection ingress is observed by the real host fence, not a timed wait.
  await f.closed.promise;release.resolve();await run;
  expect(f.host.fencedReason).toMatch(/approval hold|host|EOF/i);
  expect(f.events.some((e:any)=>String(e).startsWith("invoke-"))).toBe(false);
  expect(f.toolRuns).toEqual(["a"]);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it("native decline after Pi journal but before actual MCP invocation fences without a false receipt",async()=>{
  const f=await fixture("tool"),entered=deferred();f.beforeMcp=deferred();f.decisionReached=deferred();
  const agent=await native(f,async()=>{f.toolRuns.push("a");entered.resolve();await f.release.promise;return {content:[{type:"text",text:"Pi-a"}],details:{}};});
  const run=agent.prompt(user as any);await entered.promise;await f.held.promise;f.release.resolve();await f.decisionReached.promise;
  expect(f.manager.getBranch().filter((e:any)=>e.message?.role==="toolResult")).toHaveLength(1);
  expect(f.events.some((e:any)=>String(e).startsWith("invoke-"))).toBe(false);
  f.send("approval/resolved",{approvalId:"approval-a",itemId:"a",decision:"abort",decidedAt:"2026-11-03T00:00:00Z",decidedByCommandId:null,policyResult:"deny",resolvedBy:"user"});
  await f.closed.promise;f.beforeMcp.resolve();await run;
  expect(f.host.fencedReason).toMatch(/approval hold/);expect(f.toolRuns).toEqual(["a"]);
  expect(f.mcpResults).toBeUndefined();expect((agent.state.messages.at(-1) as any).stopReason).toBe("error");
 });
 it("Pi abort during an approval hold never sends allow_once or dispatches MCP",async()=>{
  const f=await fixture("tool"),entered=deferred(),release=f.release;
  const agent=await native(f,async()=>{entered.resolve();await release.promise;return {content:[{type:"text",text:"Pi-a"}],details:{}};});
  const run=agent.prompt(user as any);await entered.promise;await f.held.promise;agent.abort();release.resolve();await run;
  expect(f.commands.some((c:any)=>c.method==="approval/decide" && c.params.choiceId==="allow_once")).toBe(false);
  expect(f.events.some((e:any)=>String(e).startsWith("invoke-"))).toBe(false);
 });
 it("Pi steering stays queued behind held approvals and verified sequential receipts",async()=>{
  const f=await fixture(),entered=deferred(),release=f.release;f.steering=true;
  const agent=await native(f,async(_id:string,args:any)=>{f.toolRuns.push(args.key);if(f.toolRuns.length===2)entered.resolve();await release.promise;return {content:[{type:"text",text:`Pi-${args.key}`}],details:{}};});
  const run=agent.prompt(user as any);await entered.promise;await f.held.promise;agent.steer({role:"user",content:"steer after results",timestamp:3} as any);
  expect(f.commands.some((c:any)=>c.method==="turn/steer")).toBe(false);
  release.resolve();await run;
  expect(f.pending).toEqual(["a","b"]);expect(f.commands.filter((c:any)=>c.method==="turn/steer")).toHaveLength(1);
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
 });
 it("declares the synthetic vendor-redacted read through native Pi, bridge and persisted ledger",async()=>{
  const real=JSON.parse(readFileSync(new URL("./fixtures/redacted-read.json",import.meta.url),"utf8"));
  const f=await fixture("tool");
  f.mutateReceipt=(item:any)=>({...item,visibleOutput:real.item.visibleOutput});
  const agent=await native(f,async()=>({content:real.sent.content,details:{}}));
  await agent.prompt(user as any);
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
  expect(f.mcpResults[0].content).toEqual(real.sent.content);
  const {flushMuseLedger,museLedgerPath}=await import("../src/request-ledger.js");
  await flushMuseLedger();
  const rows=readFileSync(museLedgerPath(),"utf8").trim().split("\n").map(l=>JSON.parse(l));
  const row=rows.find((r:any)=>r.processId===f.host.ledger.processId&&r.type==="tool_result_vendor_redaction");
  expect(row).toMatchObject({count:3,callId:"a",exactModelConsumption:false,rule:"unique-nonempty-intraline-context-v2"});
  const redactedText=real.sent.content[0].text;
  expect(row.spans.map((s:any)=>s.piOffsetBytes)).toEqual([redactedText.indexOf("sk-"),redactedText.indexOf("sk-A"),redactedText.indexOf("sk-SECRET12")]);
  expect(row.spans.map((s:any)=>s.piByteLen)).toEqual([3,4,11]);
  expect(JSON.stringify(row)).not.toContain("github_pat_");
 });
 it("delivers one success and three fixture Pi errors through a sequential four-call MCP batch",async()=>{
  const f=await fixture("tool-errors");
  const agent=await native(f,async(_id:string,args:any)=>{
   f.toolRuns.push(args.key);
   if(args.key!=="a")throw new Error(realErrors.piErrors[args.key.charCodeAt(0)-98].content[0].text);
   return {content:[{type:"text",text:"Pi-a"}],details:{}};
  });
  await agent.prompt(user as any);
  expect(f.toolRuns).toEqual(["a","b","c","d"]);
  expect(f.mcpResults.map((r:any)=>r.isError)).toEqual([false,true,true,true]);
  expect(f.mcpResults.slice(1).map((r:any)=>r.content)).toEqual(realErrors.piErrors.map((r:any)=>r.content));
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
  expect(f.pending).toEqual(["a","b","c","d"]);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it("awaits stored output verification before a terminal frame and accepts exact large text",async()=>{
  // 51199 bytes is a measured read result, not a limit.
  const f=await fixture("tool");f.stored="x".repeat(51199);f.readGate=deferred();f.readEntered=deferred();
  f.mutateReceipt=(item:any)=>({...item,truncated:true,visibleOutput:"x",outputRef:{id:"output",availability:"available",byteLen:Buffer.byteLength(f.stored),mediaType:"text/plain"}});
  const agent=await native(f,async()=>({content:[{type:"text",text:f.stored}],details:{}})),run=agent.prompt(user as any);
  await f.readEntered.promise;
  expect(f.commands.some((c:any)=>c.method==="item/readOutput")).toBe(true);
  expect((agent.state.messages.filter((m:any)=>m.role==="assistant").at(-1) as any).stopReason).toBe("toolUse");
  f.readGate.resolve();await run;
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
  const read=f.commands.find((c:any)=>c.method==="item/readOutput");
  expect(read.params).toEqual({sessionId:"fixture",itemId:"a",outputRef:"output",offsetBytes:0});
 });
 it("holds the next batch approval until stored receipt verification drains its committed spec",async()=>{
  const f=await fixture("next-batch");f.stored="Pi-a";f.readGate=deferred();f.readEntered=deferred();f.nextApproval=deferred();
  f.mutateReceipt=(item:any)=>item.callId==="a"?{...item,truncated:true,visibleOutput:"Pi-",outputRef:{id:"output",availability:"available",byteLen:4}}:item;
  const agent=await native(f),run=agent.prompt(user as any);
  await f.readEntered.promise;await f.nextApproval.promise;
  expect(f.commands.filter((c:any)=>c.method==="approval/decide")).toHaveLength(1);
  f.readGate.resolve();await run;
  expect(f.toolRuns).toEqual(["a","b"]);
  expect((agent.state.messages.at(-1) as any).errorMessage).toBeUndefined();
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
  expect(f.commands.find((c:any)=>c.method==="approval/decide"&&c.params.approvalId==="approval-b").params.requirementId).toEqual({approvalId:"approval-b",sourceIndex:0});
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it.each([
  [{type:"text",text:""},{type:"text",text:"b"}],
  [{type:"image",data:"YWJj",mimeType:"image/png"}],
  [{type:"text",text:"note"},{type:"image",data:"YWJj",mimeType:"image/png"}],
 ])("rejects unprovable tool parts before any MCP response %j",async (...content)=>{
  const f=await fixture("tool"),agent=await native(f,async()=>({content,details:{}}));
  await agent.prompt(user as any);
  expect((agent.state.messages.at(-1) as any).errorMessage).toMatch(/part boundaries/);
  expect(f.mcpResults).toBeUndefined();
 });
 it.each(multipartCaptures)("delivers $scenario through real Pi journal, SDK and MCP without replay",async capture=>{
  const f=await fixture("tool");f.capturedOutput=capture.item.visibleOutput;
  const agent=await native(f,async()=>({...structuredClone(capture.sent),details:{}}));
  await agent.prompt(user as any);
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
  expect(f.mcpResults).toEqual([capture.sent]);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
  const journal=f.manager.getBranch().find((e:any)=>e.message?.role==="toolResult").message;
  expect(journal.content).toEqual(capture.sent.content);
  const images=f.ledgerRecords.filter((r:any)=>r.type==="tool_result_image_unverifiable");
  if(capture.scenario==="text_image"){
   expect(images).toHaveLength(1);
   expect(images[0]).toMatchObject({callId:"a",piToolCallId:journal.toolCallId,itemId:"a",delivered:true,unverifiableInContent:true,exactModelConsumption:false,rule:"mcp-image-placeholder-v1",images:[{partIndex:1,byteLen:Buffer.from(capture.sent.content[1].data,"base64").length,mimeType:"image/png"}]});
   expect(images[0].images[0].sha256).toBe(createHash("sha256").update(Buffer.from(capture.sent.content[1].data,"base64")).digest("hex"));
  }else expect(images).toEqual([]);
 });
 it("refuses mutated native image placeholder without a delivery ledger entry or replay",async()=>{
  const capture=multipartCaptures[1],f=await fixture("tool");f.capturedOutput=capture.item.visibleOutput.replace(/bytes=\d+/,"bytes=850");
  const agent=await native(f,async()=>({...structuredClone(capture.sent),details:{}}));await agent.prompt(user as any);
  expect((agent.state.messages.at(-1) as any).errorMessage).toMatch(/image placeholder differs/);
  expect(f.ledgerRecords.filter((r:any)=>r.type==="tool_result_image_unverifiable")).toEqual([]);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
  expect(f.mcpResults).toHaveLength(1);
 });
 it("rejects changed stored text at the bridge receipt boundary",async()=>{
  const f=await fixture("tool");f.stored="Pi-b";
  f.mutateReceipt=(item:any)=>({...item,truncated:true,visibleOutput:"Pi-",outputRef:{id:"output",availability:"available",byteLen:4}});
  const agent=await native(f);await agent.prompt(user as any);
  expect((agent.state.messages.at(-1) as any).errorMessage).toMatch(/tool result mismatch/);
 });
 it.each([{tool:"mcp__pi__other"},{args:'{"key":"wrong"}'}])("rejects receipt invocation mutation %j",async mutation=>{
  const f=await fixture("tool");f.mutateReceipt=(item:any)=>({...item,...mutation});
  const agent=await native(f);await agent.prompt(user as any);
  expect((agent.state.messages.at(-1) as any).errorMessage).toMatch(/invocation differs|Undeclared Muse tool item/);
 });
 it("rejects a mutated MCP error status instead of treating an error as success",async()=>{
  const f=await fixture("tool");f.mutateReceipt=(item:any)=>({...item,status:"completed"});
  const agent=await native(f,async()=>{throw new Error(realErrors.piErrors[0].content[0].text);});
  await agent.prompt(user as any);
  expect((agent.state.messages.at(-1) as any).errorMessage).toMatch(/requires failed status/);
 });
 it("runs a sequential Muse batch through native Pi 1.5 tools and journals one assistant with two calls",async()=>{
  const f=await fixture(),agent=await native(f);await agent.prompt(user as any);
  expect(f.toolRuns.sort()).toEqual(["a","b"]);
  expect(f.events.indexOf("approved-a")).toBeGreaterThanOrEqual(0);
  expect(f.events.indexOf("approved-a")).toBeLessThan(f.events.indexOf("invoke-a"));
  expect(f.events.indexOf("invoke-a")).toBeLessThan(f.events.indexOf("receipt-a"));
  expect(f.events.indexOf("receipt-a")).toBeLessThan(f.events.indexOf("approval-b"));
  const messages=agent.state.messages;
  expect(messages.filter((m:any)=>m.role==="assistant"&&m.content.some((c:any)=>c.type==="toolCall"))).toHaveLength(1);
  expect(messages.filter((m:any)=>m.role==="toolResult")).toHaveLength(2);
  expect((messages.at(-1) as any).stopReason).toBe("stop");
  expect(f.manager.getBranch().filter((e:any)=>e.type==="message"&&e.message.role==="toolResult")).toHaveLength(2);
 });
 it("runs the single-call no-batch path without requiring a committed list",async()=>{
  const f=await fixture("no-batch"),agent=await native(f);await agent.prompt(user as any);
  expect(f.toolRuns).toEqual(["a"]);expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
 });
 it("rejects a sequential invocation differing from its committed spec without rerunning Pi",async()=>{
  const f=await fixture();f.mismatch=true;const agent=await native(f);await agent.prompt(user as any);
  expect(f.toolRuns.sort()).toEqual(["a","b"]);
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("error");
  expect(f.host.fencedReason).toMatch(/MCP invocation|batch/);
 });
 it("abort between sequential invocations never reexecutes the remaining Pi call",async()=>{
  const f=await fixture();f.beforeNext=deferred();f.betweenCalls=deferred();
  const abort=new AbortController();
  const first=await f.provider.streamViaMuse(model,f.context([user]),{signal:abort.signal}).result();
  const calls=first.content.filter((c:any)=>c.type==="toolCall"),results=calls.map(f.result);
  f.entries=results.map((message:any,i:number)=>({type:"message",id:`abort-journal-${i}`,message}));
  const run=f.provider.streamViaMuse(model,f.context([user,first,...results]),{signal:abort.signal}).result();
  await f.betweenCalls.promise;abort.abort();f.beforeNext.resolve();
  expect((await run).stopReason).toBe("aborted");await f.closed.promise;
  expect(f.events).not.toContain("approval-b");expect(f.pending).toEqual(["a"]);
  const retry=await f.provider.streamViaMuse(model,f.context([user,first,...results])).result();
  expect(retry.stopReason).toBe("error");expect(f.opens).toBe(1);
 });
 it("native Pi queues steering during a stream and submits it once only after completion",async()=>{
  const f=await fixture("stream"),agent=await native(f),run=agent.prompt(user as any);await f.textSeen.promise;
  agent.steer({role:"user",content:"Queued stream steer",timestamp:3} as any);
  f.send("turn/completed",{terminal:"completed"});
  // Pi delivers this after the first assistant ends; exactly one ordinary
  // append enters the parked host, not an unsolicited transport-side input.
  await run;
  expect(f.commands.filter((x:any)=>x.method==="turn/start")).toHaveLength(2);
  expect(f.commands.filter((x:any)=>x.method==="turn/steer")).toHaveLength(0);
  expect(agent.state.messages.some((m:any)=>m.role==="user"&&m.content==="Queued stream steer")).toBe(true);
 });
 for(const stage of ["tool","approval"]){
  it(`native Pi abort during ${stage} leaves truthful tool history and no effect after approval`,async()=>{
   const f=await fixture("tool"),entered=deferred(),abortSeen=deferred(),release=deferred();let runs=0;
   const hold=async(signal:AbortSignal)=>{entered.resolve();await new Promise(resolve=>signal.addEventListener("abort",()=>{abortSeen.resolve();resolve(undefined);},{once:true}));await release.promise;};
   const wait=async(_ctx:any,signal:AbortSignal)=>{await hold(signal);return {block:true,reason:"Operation aborted"};};
   const execute=async(_id:string,_args:any,signal:AbortSignal)=>{runs++;await hold(signal);return {content:[{type:"text",text:"Operation aborted"}],details:{}};};
   const agent=await native(f,execute,stage==="approval"?wait:undefined),run=agent.prompt(user as any);
   try {
    await entered.promise;agent.abort();await abortSeen.promise;
    // Must retire BEFORE Pi returns the aborted tool result; provider re-entry
    // with an already-aborted signal must not make this proof pass by accident.
    expect(f.host.fencedReason).toMatch(/Request aborted/);
   }finally{release.resolve();await run;}
   await f.closed.promise;
   expect(runs).toBe(stage==="approval"?0:1);
   expect(agent.state.messages.filter((m:any)=>m.role==="toolResult")).toHaveLength(1);
   expect(f.commands.filter((x:any)=>x.method==="turn/start")).toHaveLength(1);
  });
 }
 it("native Pi steering during a tool attaches its result then steers the active turn",async()=>{
  const f=await fixture();f.steering=true;const entered=deferred(),release=deferred();
  const agent=await native(f,async(_id:string,args:any)=>{entered.resolve();await release.promise;f.toolRuns.push(args.key);return {content:[{type:"text",text:`Pi-${args.key}`}],details:{}};}),run=agent.prompt(user as any);
  await entered.promise;agent.steer({role:"user",content:"Tool-time steer",timestamp:3} as any);release.resolve();await run;
  expect(f.toolRuns.sort()).toEqual(["a","b"]);
  expect(f.events.indexOf("receipt-b")).toBeLessThan(f.events.indexOf("terminal"));
  expect(f.commands.filter((x:any)=>x.method==="turn/steer").map((x:any)=>x.params.input[0].text)).toEqual(["Tool-time steer"]);
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");
 });
 it("collects the complete committed parallel batch despite tool_started before tool_calls",async()=>{
  const f=await fixture("concurrent");
  const first=await f.provider.streamViaMuse(model,f.context([user])).result();
  expect(first.stopReason).toBe("toolUse");
  const calls=first.content.filter((x:any)=>x.type==="toolCall");expect(calls.map((c:any)=>c.arguments.key)).toEqual(["a","b"]);
  const results=calls.map(f.result);f.entries=results.map((message:any,i:number)=>({type:"message",id:`journal-${i}`,message}));
  const final=await f.provider.streamViaMuse(model,f.context([user,first,...results])).result();
  expect(final.stopReason).toBe("stop");expect(f.pending.sort()).toEqual(["a","b"]);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
  expect(f.commands.filter((c:any)=>c.method==="turn/steer")).toHaveLength(0);
 });
 it('fails loudly when the native turn ends before extra Pi user context can be steered; never drops it as success',async()=>{
  const f=await fixture('tool');f.stored='Pi-a';f.readGate=deferred();f.readEntered=deferred();f.terminalSeen=deferred();
  f.mutateReceipt=(item:any)=>({...item,truncated:true,visibleOutput:'Pi-',outputRef:{id:'output',availability:'available',byteLen:4}});
  const first=await f.provider.streamViaMuse(model,f.context([user])).result();
  const call=first.content.find((x:any)=>x.type==='toolCall'),result=f.result(call);
  f.entries=[{type:'message',id:'race-journal',message:result}];
  const context=f.context([user,first,result,{role:'user',content:'CURRENT STEERING'},{role:'user',content:'EXTENSION CONTEXT'}]);
  const running=f.provider.streamViaMuse(model,context).result();
  await f.readEntered.promise;await f.terminalSeen.promise;f.readGate.resolve();
  const final=await running;
  expect(final.stopReason).toBe('error');expect(final.errorMessage).toContain('steering target completed; no resubmit');
  expect(f.pending).toEqual(['a']);
  expect(f.commands.filter((c:any)=>c.method==='turn/start')).toHaveLength(1);
  const retry=await f.provider.streamViaMuse(model,context).result();
  expect(retry.stopReason).toBe('error');expect(retry.errorMessage).toContain('no automatic resubmit');
  expect(f.opens).toBe(1);
 });
 it("preserves typed image steering after journaled tool results across the merged SDK seam",async()=>{
  const f=await fixture("tool");f.steering=true;
  const first=await f.provider.streamViaMuse(model,f.context([user])).result();
  const call=first.content.find((x:any)=>x.type==="toolCall"),result=f.result(call);
  f.entries=[{type:"message",id:"image-steer-journal",message:result}];
  const steer={role:"user",content:[{type:"text",text:"Inspect this image"},{type:"image",data:"aW1hZ2U=",mimeType:"image/png"}],timestamp:3};
  const final=await f.provider.streamViaMuse(model,f.context([user,first,result,steer])).result();
  expect(final.stopReason).toBe("stop");
  const commands=f.commands.filter((c:any)=>c.method==="turn/steer");expect(commands).toHaveLength(1);
  expect(commands[0].params.input).toEqual([{type:"text",text:"Inspect this image"},{type:"image",base64Data:"aW1hZ2U=",mediaType:"image/png"}]);
  expect(f.events.indexOf("receipt-a")).toBeLessThan(f.events.lastIndexOf("terminal"));
 });
 it("attaches journaled tool results before genuine steering, never steers the result",async()=>{
  const f=await fixture("tool");f.steering=true;
  const first=await f.provider.streamViaMuse(model,f.context([user])).result();const call=first.content.find((x:any)=>x.type==="toolCall"),result=f.result(call);
  f.entries=[{type:"message",id:"journal",message:result}];
  const steer={role:"user",content:"Use the checked result to finish the task",timestamp:3};
  const final=await f.provider.streamViaMuse(model,f.context([user,first,result,steer])).result();
  expect(final.stopReason).toBe("stop");
  const commands=f.commands.filter((c:any)=>c.method==="turn/steer");expect(commands).toHaveLength(1);expect(commands[0].params.input[0].text).toBe(steer.content);
  expect(f.events.indexOf("receipt-a")).toBeLessThan(f.events.lastIndexOf("terminal"));
 });
 for(const mode of ["stream","tool","approval"]){
  it(`aborts during ${mode}, preserving Pi output and retiring only owned processes`,async()=>{
   const f=await fixture(mode),abort=new AbortController();
   const run=f.provider.streamViaMuse(model,f.context([user]),{signal:abort.signal}).result();
   if(mode==="approval")await f.approval.promise;
   else if(mode==="tool")expect((await run).stopReason).toBe("toolUse");
   else await f.textSeen.promise;
   abort.abort();
   if(mode!=="tool"){const result=await run;expect(result.stopReason).toBe("aborted");if(mode==="stream")expect(result.content[0].text).toBe("Partial truthful text");}
   expect(f.host.fencedReason).toMatch(/Request aborted/);
   await f.closed.promise;
   expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
   expect(f.children.every((c:any)=>c.exitCode!==null)).toBe(true);
   if(mode==="approval")expect(f.children).toHaveLength(0);
  });
 }
 it("fails host death mid-turn clearly and refuses Pi's resubmission of the same user entry",async()=>{
  const f=await fixture("death");
  const first=await f.provider.streamViaMuse(model,f.context([user])).result();expect(first.stopReason).toBe("error");expect(first.errorMessage).toMatch(/host died/);
  const retry=await f.provider.streamViaMuse(model,f.context([user])).result();expect(retry.stopReason).toBe("error");expect(retry.errorMessage).toMatch(/no automatic resubmit/);
  expect(f.opens).toBe(1);expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it("latches a command admission HTTP 403 without submitting again",async()=>{
  const f=await fixture("admission-denied");const result=await f.provider.streamViaMuse(model,f.context([user])).result();expect(result.stopReason).toBe("error");
  const {assertMusePolicySafe}=await import("../src/host.js");expect(assertMusePolicySafe).toThrow(/latched/);
  await expect(f.host.submitInput("new request")).rejects.toThrow(/latched/);
  expect(f.commands.filter((x:any)=>x.method==="turn/start")).toHaveLength(1);
 });
 it("sends one admission command even when the official SDK receives a retryable error",async()=>{
  const f=await fixture("admission-retry");
  const result=await f.provider.streamViaMuse(model,f.context([user])).result();expect(result.stopReason).toBe("error");
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it("leaves a known nothing-admitted overload retry to Pi's next provider call",async()=>{
  const f=await fixture("admission-retry");
  await f.provider.streamViaMuse(model,f.context([user])).result();
  expect(f.opens).toBe(1);expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
  const retried=await f.provider.streamViaMuse(model,f.context([user])).result();
  expect(retried.stopReason).toBe("error");expect(f.opens).toBe(2);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(2);
 });
 it.each(["turn/retryScheduled","turn/modelRetryScheduled"])("503 vendor retry continues and completes without a tether replay: %s",async(method)=>{
  const {setRetryStatusListener}=await import("../src/retry-status.js");const statuses:any[]=[];setRetryStatusListener(s=>statuses.push(s));
  const f=await fixture("retry-complete");f.retryMethod=method;const result=await f.provider.streamViaMuse(model,f.context([user])).result();
  expect(result.stopReason).toBe("stop");expect(f.host.fencedReason).toBeUndefined();
  expect(statuses.some(s=>s?.includes("HTTP 503"))).toBe(true);expect(statuses.at(-1)).toBeUndefined();
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it("vendor retry after committed tools preserves one execution and receipts per call",async()=>{
  const f=await fixture("vendor-tools"),agent=await native(f);await agent.prompt(user as any);
  expect(f.toolRuns).toEqual(["a","b"]);expect(f.pending).toEqual(["a","b"]);
  expect((agent.state.messages.at(-1) as any).stopReason).toBe("stop");expect(f.host.fencedReason).toBeUndefined();
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it("abort during vendor retry delay cancels the turn truthfully",async()=>{
  const f=await fixture("retry-hold"),abort=new AbortController();f.retrySeen=deferred();
  const run=f.provider.streamViaMuse(model,f.context([user]),{signal:abort.signal}).result();await f.retrySeen.promise;
  expect(f.host.fencedReason).toBeUndefined();abort.abort();expect(f.host.fencedReason).toMatch(/Request aborted/);expect((await run).stopReason).toBe("aborted");await f.closed.promise;
  expect(f.commands.some((c:any)=>c.method==="turn/cancel")).toBe(true);
  expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 it.each(["retry-fail","retry-fail-no-status"])("exhausted vendor retry carries HTTP status; Pi retry fails clearly without resubmit: %s",async(mode)=>{
  const {isRetryableAssistantError}=await import("@earendil-works/pi-ai/compat");
  const f=await fixture(mode);const failed=await f.provider.streamViaMuse(model,f.context([user])).result();
  expect(failed.errorMessage).toContain("HTTP 503");expect(isRetryableAssistantError(failed)).toBe(true);
  for(const messages of [[user],[user,{role:"toolResult",toolCallId:"old",content:[]}]] as any[]){
   const retried=await f.provider.streamViaMuse(model,f.context(messages)).result();
   expect(retried.errorMessage).toMatch(/no automatic resubmit/);expect(isRetryableAssistantError(retried)).toBe(false);
  }
  expect(f.opens).toBe(1);expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
 });
 for(const mutation of [{errorKind:"newUnknownKind"},{errorKind:"server",httpStatus:403},{errorKind:"authRequired"},{errorKind:"quotaExceeded"},{errorKind:"client_attestation_denied"},{errorKind:"server",code:"plan_usage_limit_exceeded"},{errorKind:"server",error:{kind:"modelError",quota:{}}}]){
  it(`retry refusal stays first and unknown kinds stop: ${JSON.stringify(mutation)}`,async()=>{
   const f=await fixture("retry-complete");f.retryMutation=mutation;
   const result=await f.provider.streamViaMuse(model,f.context([user])).result();expect(result.stopReason).toBe("error");
   expect(f.host.fencedReason).toMatch(mutation.errorKind==="newUnknownKind"?/unknown retry kind/:/latched/);
   if(mutation.errorKind!=="newUnknownKind")await expect(f.host.submitInput("never retry")).rejects.toThrow(/latched/);
   expect(f.commands.filter((c:any)=>c.method==="turn/start")).toHaveLength(1);
  });
 }
 it("pins the experimental rawLog payload to the exact qualified client build",async()=>{
  const {assertQualifiedVersions}=await import("../src/cli-version.js");
  expect(()=>assertQualifiedVersions("Muse Code 1.4.14 (1.4.14-R7309.1)","1.4.14",true)).not.toThrow();
  for(const output of ["Muse Code 1.4.14","Muse Code 1.4.14 (1.4.14-R7309.2)"])
   expect(()=>assertQualifiedVersions(output,"1.4.14",true)).toThrow(/Unqualified/);
 });
 it("rejects a missing rawLog grant before opening/submitting a model turn",async()=>{
  const {MuseHost}=await import("../src/host.js");const frames=new Frames();const connection=new Connection({incoming:frames,async write(){},close(){frames.end();}});
  expect(()=>new MuseHost(connection,{sessionDurability:"ephemeral",grantedCapabilities:["sessionMcp"]} as any,{cwd:process.cwd(),tools:["lookup"],promptMode:"none",echo:true,toolBatches:true})).toThrow(/rawLog capability absent/);
  await connection.close();
 });
 for(const error of [{httpStatus:403},{data:{cause:{kind:"client_attestation_denied"}}},{message:"HTTP 403 account blocked"}]){
  it(`latches vendor error fields ${JSON.stringify(error)} across new hosts`,async()=>{
   const f=await fixture("stream"),run=f.provider.streamViaMuse(model,f.context([user])).result();await f.started.promise;
   f.send("turn/completed",{terminal:"failed",error});expect((await run).stopReason).toBe("error");
   const {assertMusePolicySafe}=await import("../src/host.js");expect(assertMusePolicySafe).toThrow(/latched/);
   await expect(f.host.submitInput("never submit")).rejects.toThrow(/latched/);
  });
 }
 it("does not latch 403 words in model text or tool output",async()=>{
  const f=await fixture("stream"),run=f.provider.streamViaMuse(model,f.context([user])).result();await f.started.promise;
  f.send("item/delta",{field:"text",itemId:"text",delta:"HTTP 403 client_attestation_denied are quoted test data"});f.send("turn/completed",{terminal:"completed"});expect((await run).stopReason).toBe("stop");
  const {assertMusePolicySafe}=await import("../src/host.js");expect(assertMusePolicySafe).not.toThrow();
 });
});
