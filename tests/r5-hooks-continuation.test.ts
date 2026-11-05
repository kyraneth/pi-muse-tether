/** Offline regression from independent hook-order challenge; no vendor calls. */
import {afterEach,expect,it} from "vitest";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {createMuseProvider} from "../src/provider.js";
const model:any={id:"echo",provider:"pi-muse-tether"};
const tools=[{name:"lookup",description:"Fixture lookup",parameters:{type:"object",properties:{key:{type:"string"}},required:["key"],additionalProperties:false}}];
const providers:any[]=[];
afterEach(async()=>{await Promise.all(providers.splice(0).map(p=>p.retireAll()));});
it("continuation frames wait for response and follow the start event",async()=>{
 const children:any[]=[];let emitHost:(event:any)=>void=()=>{};
 const entries:any[]=[];
 const journal=(entry:any)=>entries.push(entry);
 const p=createMuseProvider({promptModes:["replace"],promptMode:"replace",instructionMechanisms:["fixture"],openHost:async(options:any)=>{
  const batch=options.purpose!=="raw"&&options.tools.length>0;
  const onEvent=options.onEvent;emitHost=(event:any)=>onEvent?.(event);
  const host:any={batches:true,fencedReason:undefined,
   fence(reason:string){if(this.fencedReason===undefined){this.fencedReason=reason;emitHost({kind:"fenced",reason});}},
   async cancelTurn(){},async close(){for(const child of children){if(child.exitCode===null){const exit=new Promise(r=>child.once("exit",r));child.stdin.end();await exit;}}},
   async submitInput(text:any){
    if(!batch)return {turnId:"t0",commandId:"c0"};
    const callId="a";
    emitHost({kind:"frame",frame:{method:"session/tokenUsage",params:{sourceRange:{last:{id:"u1"}},usage:{inputTokens:10,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}}});
    emitHost({kind:"tool-batch",calls:[{callId,name:"mcp__pi__lookup",args:{key:"a"}}]});
    if(!options.validateApproval({toolName:"mcp__pi__lookup",toolCallId:callId,rawArgs:JSON.stringify({key:"a"}),approvalId:callId,currentRequirementId:callId,sessionId:"challenge",turnId:"t1"}))throw new Error("fixture approval denied");
    const descriptor=(options.mcpServers as any).pi;
    const child=spawn(descriptor.command,descriptor.args,{env:{...process.env,...descriptor.env},stdio:["pipe","pipe","pipe"]});
    children.push(child);child.stderr.resume();
    createInterface({input:child.stdout}).on("line",line=>{
     const message=JSON.parse(line);if(!message.result)return;
     emitHost({kind:"frame",frame:{method:"item/completed",params:{item:{kind:"toolCall",tool:"mcp__pi__lookup",callId,itemId:callId,turnId:"t1",revision:2,status:"completed",args:JSON.stringify({key:"a"}),visibleOutput:"Pi-a"}}}});
     emitHost({kind:"terminal",turnId:"t1",status:"completed",frame:{method:"turn/completed",params:{turnId:"t1",terminal:"completed"}}});
    });
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:callId,method:"tools/call",params:{name:"lookup",arguments:{key:"a"},_meta:{callId}}})+"\n");
    return {turnId:"t1",commandId:"c1"};
   }};
  return host;
 }});
 p.setSessionManager({getSessionId:()=>"challenge-continuation",getSessionFile:()=>"fixture.jsonl",getBranch:()=>entries});
 providers.push(p);
 const first:any[]=[];
 for await(const event of p.streamViaMuse(model,{systemPrompt:"S",messages:[{role:"user",content:"q"}],tools},{}))first.push(event);
 const toolCall=first.find(e=>e.type==="toolcall_end")?.toolCall;
 expect(toolCall?.name).toBe("lookup");
 journal({id:"entry-1",type:"message",message:{role:"toolResult",toolCallId:toolCall.id,toolName:"lookup",content:[{type:"text",text:"Pi-a"}],isError:false}});
 // Native trailing text after the committed batch, while no episode is live.
 emitHost({kind:"frame",frame:{method:"item/delta",params:{field:"text",delta:"TRAILING_BEFORE_RESPONSE"}}});
 let release!:()=>void;let entered=false;let markEntered!:()=>void;
 const responseEntered=new Promise<void>(resolve=>{markEntered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const responses:any[]=[];const controller=new AbortController();
 const events:any[]=[];
 const stream=p.streamViaMuse(model,{systemPrompt:"S",messages:[
  {role:"user",content:"q"},
  {role:"assistant",content:[{type:"toolCall",id:toolCall.id,name:"lookup",arguments:{key:"a"}}]},
  {role:"toolResult",toolCallId:toolCall.id,toolName:"lookup",content:[{type:"text",text:"Pi-a"}],isError:false},
 ],tools},{signal:controller.signal,
  onResponse:async response=>{entered=true;markEntered();responses.push(response);await gate;},
  onProviderStreamEvent:async()=>{},
 });
 const done=(async()=>{for await(const event of stream)events.push(event);})();
 await responseEntered;
 // Cross the event-loop phase after all already-queued microtasks; no polling.
 await new Promise(resolve=>setImmediate(resolve));
 // No buffered content may bypass this new logical request response gate.
 const text=events.filter(e=>e.type==="text_delta").map((e:any)=>e.delta).join("");
 expect(text).toBe("");
 expect(events.some(e=>e.type==="start")).toBe(false);
 expect(entered).toBe(true);
 expect(responses).toHaveLength(1); // entered but not settled
 release();
 await done;
 const start=events.findIndex(e=>e.type==="start");
 const delta=events.findIndex(e=>e.type==="text_delta");
 expect(start).toBeGreaterThanOrEqual(0);expect(delta).toBeGreaterThan(start);
 const last=events.at(-1);
 expect(last?.type).toBe("done");
 expect((last as any).message.stopReason).toBe("stop");
 expect(responses).toHaveLength(1);
});
