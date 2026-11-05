/** Opt-in native Pi hook qualification; logs only fixture metadata. */
import {appendFile} from "node:fs/promises";
import {Type} from "typebox";
export default function(pi:any){
 const log=async(row:any)=>appendFile(process.env.MUSE_HOOK_LOG!,JSON.stringify(row)+"\n");
 pi.registerTool({name:"hook_removed",label:"Removed hook fixture",description:"Must be removed before official-client submission",parameters:Type.Object({}),async execute(){await log({kind:"removed-tool-executed"});return {content:[{type:"text",text:"BAD_REMOVED_TOOL_EXECUTED"}],details:{}};}});
 pi.on("before_provider_request",async(event:any)=>{
  const p=event.payload;await log({kind:"payload",transport:p.transport,tools:p.tools?.map((t:any)=>t.name)});
  return {...p,systemPrompt:'HOOK_SYSTEM_REPLACED_14',messages:[{role:"user",content:"Reply with exactly HOOK_REPLACED_14 and no tools.",timestamp:Date.now()}],tools:p.tools.filter((t:any)=>t.name!=="hook_removed")};
 });
 pi.on("after_provider_response",async(event:any)=>{await Promise.resolve();await log({kind:"response",status:event.status,headers:event.headers});});
 pi.on("provider_stream_event",async(event:any)=>{await Promise.resolve();await log({kind:"stream",transport:event.data.transport,source:event.data.source,eventKind:event.data.event.kind});});
}
