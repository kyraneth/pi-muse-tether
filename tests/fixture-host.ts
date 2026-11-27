/** Offline MSP fixture, never a vendor endpoint or token/cost measurement. */
import { Connection } from "@muse-code/sdk";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { MuseHost, type MuseHostOptions } from "../src/host.js";
import { writePromptSettings } from "../src/settings.js";
import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const fixtureState:any={raw:"success",coding:"normal",opens:[],events:[],rawHold:undefined,rawStarted:undefined};
const digest=(s:any)=>createHash("sha256").update(s).digest("hex");
async function record(event:any){fixtureState.events.push(event);if(process.env.FIXTURE_HOST_LOG)await appendFile(process.env.FIXTURE_HOST_LOG,JSON.stringify(event)+"\n");}
class Frames implements AsyncIterable<string> {
 values:any[]=[];waiters:any[]=[];
 push(frame:any){const value={value:JSON.stringify(frame)+"\n",done:false};const next=this.waiters.shift();if(next)next(value);else this.values.push(value);}
 end(){const value={done:true};const next=this.waiters.shift();if(next)next(value);else this.values.push(value);}
 [Symbol.asyncIterator](){return{next:()=>Promise.resolve(this.values.shift()??new Promise(resolve=>this.waiters.push(resolve)))}};
}
export async function openFixtureHost(options:MuseHostOptions):Promise<MuseHost>{
 fixtureState.nextId=(fixtureState.nextId??0)+1;
 const id=`fixture-${fixtureState.nextId}`;const purpose=options.purpose??"coding";
 const root=await mkdtemp(join(tmpdir(),"fixture-host-"));
 await writePromptSettings(root,options.privatePrompt?.systemPrompt??"",options.tools);
 const path=join(root,"config/muse/settings.json"),settings=JSON.parse(await readFile(path,"utf8"));
 const descriptor:any=(options.mcpServers as any)?.pi;const schemaPath=descriptor?.args?.at(-1);
 if(purpose==='coding'){
  fixtureState.codingBeforeRead?.({schemaPath,path});
  if(fixtureState.codingReadHold){
   let cancel!:()=>void;const aborted=new Promise((_,reject)=>{cancel=()=>reject(new Error("Fixture startup aborted"));options.signal?.addEventListener("abort",cancel,{once:true});if(options.signal?.aborted)cancel();});
   try {await Promise.race([fixtureState.codingReadHold,aborted]);}
   catch(error){await rm(root,{recursive:true,force:true});throw error;}
   finally {options.signal?.removeEventListener("abort",cancel);}
  }
 }
 const schemaHash=schemaPath?digest(await readFile(schemaPath)):undefined;
 fixtureState.opens.push({id,purpose,path,schemaPath,schemaHash,settings,closed:false});
 await record({kind:"open",id,purpose,path,schemaPath,schemaHash,settings});
 const incoming=new Frames();let turn=0;let connection:Connection;
 const reply=(f:any,result:any)=>incoming.push({jsonrpc:"2.0",id:f.id,result});
 const notify=(method:string,params:any)=>incoming.push({jsonrpc:"2.0",method,params:{sessionId:id,sourceRange:{first:{id:`${id}-${turn}-${method}`,sequence:turn},last:{id:`${id}-${turn}-${method}`,sequence:turn},stream:{id,kind:"session"}},viewCursor:`${id}-${turn}-${method}`,...params}});
 const transport:any={incoming,async write(chunk:string){
  const f=JSON.parse(chunk),p=f.params??{};
  if (fixtureState.quotaPush) await record({kind:"method",method:f.method});
  if(f.method==="session/start"){fixtureState.sessionStart=p;reply(f,{session:{sessionId:id,permissionState:{reviewerAuthority:fixtureState.reviewer??"human",profileId:":ask-me",reviewerAttached:true,axes:{approval:"onRequest",filesystem:"sandboxed",network:"off",reviewer:fixtureState.reviewer??"human"}}},viewCursor:"0"});}
  else if(f.method==="usage/read")reply(f,{usage:{}});
  // 1.4.14 answers methodNotFound; a scripted 1.4.15 inventory sequence models
  // asynchronous session MCP startup (last entry repeats).
  else if(f.method==="mcpServer/readInventory"){
   const seq=fixtureState.inventory;fixtureState.inventoryReads=(fixtureState.inventoryReads??0)+1;
   fixtureState.onInventory?.();
   if(fixtureState.inventoryError)incoming.push({jsonrpc:"2.0",id:f.id,error:fixtureState.inventoryError});
   else if(!seq)incoming.push({jsonrpc:"2.0",id:f.id,error:{code:-32601,message:"method not found",data:{kind:"methodNotFound",retryable:false}}});
   else reply(f,{servers:seq[Math.min(fixtureState.inventoryReads-1,seq.length-1)]});
  }
  else if(f.method==="turn/cancel")reply(f,{commandId:p.commandId,status:"accepted"});
  else if(f.method==="turn/start"){
   const chat=purpose==="raw" && process.env.FIXTURE_HOST_TOOL_FREE_CHAT==="1";
   const stage=p.input[0].text?.startsWith("[Pi replay stage "), staged=process.env.FIXTURE_HOST_STAGE_LOG==="1";
   turn++;await record({kind:"input",id,purpose,commandId:p.commandId,effort:p.reasoningEffort,text:p.input[0].text,
    ...(chat || staged ? {parts:p.input,bytes:Buffer.byteLength(chunk),requestId:f.id} : {})});
   if (fixtureState.beforeTurnStart?.({ close:()=>incoming.end(), reply, notify, frame:f,
    refuse:(error:any)=>incoming.push({jsonrpc:"2.0",id:f.id,error}) })) return;
   // The client's own oversized-frame refusal, verbatim shape from the app-server.
   if(fixtureState.inputTooLarge){fixtureState.inputTooLarge=false;incoming.push({jsonrpc:"2.0",id:f.id,error:{code:-32002,message:"frame exceeds the inbound limit",data:{kind:"inputTooLarge",limitBytes:10485760,retryable:false}}});return;}
   const quota=fixtureState.quotaMode && !fixtureState.quotaIssued;
   if(quota)fixtureState.quotaIssued=true;
   if(quota && fixtureState.quotaMode==="admission") {
    await record({kind:"quota",phase:"admission"});
    incoming.push({jsonrpc:"2.0",id:f.id,error:{code:-32001,message:"Synthetic rate limit HTTP 429",data:{kind:"rate_limit",httpStatus:429,retryable:true,quota:{}}}});return;
   }
   const queued=stage && fixtureState.stage==="queued";
   reply(f,{commandId:p.commandId,status:"accepted",disposition:queued ? "queued" : "started",startedNewTurn:!queued,turnId:p.commandId});
   if (queued) { fixtureState.stageReached?.(); await fixtureState.stageGate; }
   notify("turn/started",{commandId:p.commandId,turnId:p.commandId});
   if (stage && fixtureState.stage==="hold") { fixtureState.stageReached?.(); return; }
   if (stage && fixtureState.stage==="transient") {
    notify("turn/completed",{turnId:p.commandId,terminal:"failed",error:{kind:"providerError",httpStatus:503,message:"upstream request failed",retryable:true}});
    return;
   }
   if (stage && fixtureState.stage==="overflow") {
    notify("turn/completed",{turnId:p.commandId,terminal:"failed",error:{kind:"contextOverflow",message:"maximum context length exceeded"}});
    return;
   }
   if (stage && fixtureState.stage==="tool") {
    const child=spawn(descriptor.command,descriptor.args,{env:{...process.env,...descriptor.env},stdio:["pipe","pipe","pipe"]});
    child.stderr.resume();
    const closed=new Promise(resolve=>child.once("close",resolve));
    const reply=new Promise<any>((resolve,reject)=>{
     child.once("error",reject);child.once("close",()=>reject(new Error("MCP fixture closed before replying")));
     createInterface({input:child.stdout}).once("line",line=>resolve(JSON.parse(line)));
    });
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:"forbidden",method:"tools/call",params:{name:"lookup",arguments:{},_meta:{callId:"forbidden"}}})+"\n");
    try { await record({kind:"stage-tool",reply:await reply}); }
    finally { child.stdin.end();await closed; }
    notify("item/started",{turnId:p.commandId,item:{kind:"toolCall",itemId:"forbidden",tool:"mcp__pi__lookup",callId:"forbidden"}});
    return;
   }
   if (fixtureState.quotaPush) notify("usage/changed", fixtureState.quotaPush);
   if(quota) {
    await record({kind:"quota",phase:"terminal"});
    notify("turn/completed",{turnId:p.commandId,terminal:"failed",error:{kind:"rate_limit",message:"Synthetic rate limit HTTP 429",httpStatus:429,quota:{}}});return;
   }
   if(purpose==="raw"){fixtureState.rawStarted?.();if(fixtureState.rawHold)await fixtureState.rawHold;}
   if(purpose==="raw"&&["helper","tool"].includes(fixtureState.raw)){
    notify("item/started",{turnId:p.commandId,item:{itemId:`${id}-bad`,kind:fixtureState.raw==="helper"?"reminderChild":"toolCall",tool:"mcp__pi__read",callId:"never-execute"}});
   }
   const overflow=purpose==="coding"&&fixtureState.coding==="overflow";
   if(overflow)fixtureState.coding="normal";
   const text=staged ? (stage ? "STAGE_HIDDEN" : "FINAL_VISIBLE") : chat ? `live fixture answer ${turn}` : purpose==="raw"?"## Goal\nSYNTHETIC_COMPACTION_MARKER_6\n\n## Next Steps\nContinue the current synthetic task.":`fixture answer ${turn}`;
   if(!overflow){
    if(chat){
      const r=`${id}-${turn}-reasoning`;
      notify("item/started",{turnId:p.commandId,item:{itemId:r,kind:"reasoning"}});
      notify("item/delta",{turnId:p.commandId,itemId:r,field:"summary.0",delta:"visible fixture thought"});
      notify("item/completed",{turnId:p.commandId,item:{itemId:r,kind:"reasoning",summary:["visible fixture thought"]}});
    }
    notify("item/started",{turnId:p.commandId,item:{itemId:`${id}-${turn}-text`,kind:"agentMessage"}});
    notify("item/delta",{turnId:p.commandId,itemId:`${id}-${turn}-text`,...(chat?{}:{field:"text"}),delta:text});
    notify("item/completed",{turnId:p.commandId,item:{itemId:`${id}-${turn}-text`,kind:"agentMessage",text:chat ? `${text}.` : purpose === "raw" && fixtureState.raw === "mismatch" ? "Other committed text" : text}});
    if(chat)notify("item/completed",{turnId:p.commandId,item:{itemId:`${id}-${turn}-tail`,kind:"agentMessage",text:"Committed-only item."}});
   }
   if (fixtureState.usageRecords) {
    for (const params of fixtureState.usageRecords) notify("session/tokenUsage", {turnId:p.commandId,...params});
   } else if(fixtureState.raw!=="no-usage"||purpose!=="raw"){
    // Synthetic protocol counters, NOT vendor-observed generation or cost.
    const input=stage ? 301 : purpose==="coding"&&fixtureState.coding==="threshold"?400001:120;
    if(fixtureState.coding==="threshold")fixtureState.coding="normal";
    notify("session/tokenUsage",{turnId:p.commandId,totalTokens:input+7,usage:{inputTokens:input,outputTokens:7,cacheReadTokens:0,cacheWriteTokens:0}});
   }
   notify("turn/completed",{turnId:p.commandId,terminal:overflow||purpose==="raw"&&fixtureState.raw==="failure"?"failed":"completed",...(overflow?{error:{kind:"contextOverflow",message:"maximum context length exceeded"}}:{})});
  }
 },close(){incoming.end();}};
 connection=new Connection(transport,{mintRequestId:randomUUID});
 const host=new MuseHost(connection,{sessionDurability:"ephemeral",grantedCapabilities:["sessionMcp"]} as any,{...options,echo: !fixtureState.quotaPush},async()=>{
  if(purpose==="coding"&&fixtureState.codingCloseHold){fixtureState.codingCloseStarted?.();await fixtureState.codingCloseHold;}
  const item=fixtureState.opens.find((x:any)=>x.id===id);item.closed=true;
  const current=digest(await readFile(path));const currentSchema=schemaPath?await readFile(schemaPath).then(bytes=>digest(bytes)).catch((error:any)=>{if(error.code==='ENOENT')return 'retired-by-bridge';throw error;}):undefined;
  await record({kind:"close",id,purpose,settingsHash:current,schemaHash:currentSchema});
  await connection.close();await rm(root,{recursive:true,force:true});item.cleaned=true;
 });
 try {await host.open();return host;}catch(error){await host.close();throw error;}
}
