import { museEffort } from "./thinking-config.js";
import { museModelRoute } from "./model-route.js";
import { publishRetryStatus } from "./retry-status.js";
import { applyMuseUsage } from "./usage.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { MuseHost, MuseHostOptions } from "./host.js";

/** Separate one-shot owner: never consults, changes or parks a coding binding. */
export function streamRawCompletion(model:any, context:any, options:any, makeMessage:(model:any)=>any,
  openHost:(options:MuseHostOptions)=>Promise<MuseHost>, promptMode:"replace") {
  const stream=createAssistantMessageEventStream();
  const output=makeMessage(model);
  const statusOwner={};
  void (async()=>{
    let host:MuseHost|undefined;
    try {
      if (context.messages.length!==1 || context.messages[0]?.role!=="user") throw new Error("Muse raw completion requires one serialized user request");
      const parts=typeof context.messages[0].content==="string"?[{type:"text",text:context.messages[0].content}]:context.messages[0].content;
      if (!Array.isArray(parts)||parts.some((p:any)=>p.type!=="text")) throw new Error("Muse raw completion requires text only");
      options.signal?.throwIfAborted();
      const content=new Map<string,string>();const usageIds=new Set<string>();
      let finish!:(value?:unknown)=>void, refuse!:(error:Error)=>void;
      const terminal=new Promise((resolve,reject)=>{finish=resolve;refuse=reject;});
      // Opening can reject before we await terminal. Install the rejection handler now.
      void terminal.catch(()=>undefined);
      const abort=()=>{refuse(new Error("Muse raw completion aborted"));void host?.close().catch(()=>undefined);};
      options.signal?.addEventListener("abort",abort,{once:true});
      try {
        host=await openHost({cwd:process.cwd(),purpose:"raw",tools:[],mcpServers:{},promptMode,
          privatePrompt:{systemPrompt:context.systemPrompt},echo:model.id==="echo",
          model:model.id==="echo"?undefined:museModelRoute(model.id)?.modelId ?? model.id,
          contributorMode:museModelRoute(model.id)?.contributorMode ?? "on",pickerModel:model.id,
          signal:options.signal,reasoningEffort:museEffort(options.reasoning),onEvent:(event:any)=>{
            if (event.kind==="fenced") {publishRetryStatus(statusOwner);refuse(new Error(event.reason));return;}
            if (event.kind==="terminal") {
              publishRetryStatus(statusOwner);
               const error=event.frame?.params?.error;
               const status=error?.httpStatus??error?.status??error?.statusCode??(event.status==="failed"?event.lastRetryHttpStatus:undefined);
               if(event.status!=="completed")refuse(new Error(`Muse raw completion ended ${event.status}${typeof status==="number"?` (HTTP ${status})`:""}${error?.message?`: ${error.message}`:""}`));else finish();
              return;
            }
            if(event.kind!=="frame")return;
            const m=event.frame.method,p=event.frame.params??{},item=p.item;
             if(["turn/retryScheduled","turn/modelRetryScheduled"].includes(m)){publishRetryStatus(statusOwner,p);return;}
            if(m.startsWith("approval/")||m.startsWith("userInput/")||m==="view/gap"||m.includes("snapshot")||
              (m==="turn/foregroundCompleted"&&p.blockingAgents?.length)||
              (item&&!["userMessage","agentMessage","reasoning"].includes(item.kind))) {
              refuse(new Error("Muse raw completion emitted tool/helper activity"));return;
            }
            if(item?.kind==="agentMessage"){
              if(typeof item.itemId!=="string"){refuse(new Error("Muse raw text lacks item identity"));return;}
              if(!content.has(item.itemId))content.set(item.itemId,"");
              if(m==="item/completed"&&typeof item.text==="string")content.set(item.itemId,item.text);
            }
            if(m==="item/delta"&&p.field==="text"){
              if(!content.has(p.itemId)){refuse(new Error("Muse raw text has no agent message item"));return;}
              content.set(p.itemId,content.get(p.itemId)+p.delta);
            }
            if(m==="session/tokenUsage"){
              const id=p.sourceRange?.last?.id??p.viewCursor;
              if(typeof id!=="string"||!p.usage){refuse(new Error("Muse raw usage lacks native identity"));return;}
              if(usageIds.has(id))return;usageIds.add(id);
              try {applyMuseUsage(output,p);} catch(error:any){refuse(error);}
            }
          }});
        host.ledger?.beginEpisode();
        await host.submitInput(parts.map((p:any)=>p.text).join("\n"),museEffort(options.reasoning));
        await terminal;
        if(content.size!==1||![...content.values()][0]?.trim())throw new Error("Muse raw completion requires exactly one nonempty assistant text");
        if(!output.usagePresence.input||!output.usagePresence.output)throw new Error("Muse raw completion missing native input/output usage");
        output.content=[{type:"text",text:[...content.values()][0]}];
        host.ledger?.endEpisode();
        await host.close();host=undefined;
        stream.push({type:"start",partial:output});stream.push({type:"done",reason:"stop",message:output});stream.end();
      } finally {publishRetryStatus(statusOwner);options.signal?.removeEventListener("abort",abort);}
    } catch(error:any){
      try { await host?.close(); } catch {} host=undefined;
      output.stopReason=options.signal?.aborted?"aborted":"error";output.errorMessage=String(error?.message??error);
      stream.push({type:"error",reason:output.stopReason,error:output});stream.end();
    } finally {try {await host?.close();} catch {}}
  })();
  return stream;
}
