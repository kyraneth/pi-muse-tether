import {afterEach,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {createMuseProvider} from "../src/provider.js";
import {fixtureState,openFixtureHost} from "./fixture-host.js";
const model:any={id:"echo",provider:"pi-muse-tether"};
const tools=[{name:"keep",description:"keep",parameters:{type:"object"}},{name:"removed",description:"removed",parameters:{type:"object"}}];
const context=(raw=false)=>({systemPrompt:"ORIGINAL",messages:[{role:"user",content:"original"}],tools:raw?[]:tools});
const providers:any[]=[];
function factory(){
 const seen:any[]=[];
 const p=createMuseProvider({promptModes:["replace"],promptMode:"replace",instructionMechanisms:["fixture"],rawCompletion:true,openHost:async options=>{
  const schema=(options.mcpServers as any)?.pi?.args?.at(-1);
  seen.push({options,schema:schema?JSON.parse(await readFile(schema,"utf8")):undefined});
  return openFixtureHost(options);
 }});
 p.setSessionManager({getSessionId:()=>"owner",getSessionFile:()=>"fixture.jsonl",getBranch:()=>[]});providers.push(p);return {p,seen};
}
afterEach(async()=>{await Promise.all(providers.splice(0).map(p=>p.retireAll()));fixtureState.opens=[];fixtureState.events=[];fixtureState.raw="success";fixtureState.coding="normal";});
it.each([false,true])("payload replacement is effective before official SDK admission raw=%s",async raw=>{
 const {p,seen}=factory();const observed:string[]=[];
 const result=await p.streamViaMuse(model,context(raw),{
  onPayload:async(payload:any)=>({...payload,systemPrompt:"REPLACED_SYSTEM",messages:[{role:"user",content:"REPLACED_INPUT"}],tools:raw?[]:[tools[0]]}),
  onResponse:async(response:any)=>{expect(fixtureState.events.some((e:any)=>e.kind==="input")).toBe(true);expect(response.status).toBe(0);expect(response.headers["x-pi-tether-response"]).toBe("logical-admission");observed.push("response");},
  onProviderStreamEvent:async(data:any)=>{expect(observed[0]).toBe("response");expect(data.transport).toBe("official-muse-client");observed.push(data.event.kind);},
 }).result();
 expect(result.stopReason,result.errorMessage).toBe("stop");expect(observed.length).toBeGreaterThan(1);
 expect(fixtureState.events.find((e:any)=>e.kind==="input").text).toContain("REPLACED_INPUT");
 expect(fixtureState.opens[0].settings.run.system_prompt).toBe("REPLACED_SYSTEM");
 if(!raw){expect(seen[0].options.tools).toEqual(["keep"]);expect(seen[0].options.validateApproval({toolName:"mcp__pi__removed",toolCallId:"bad",rawArgs:"{}"})).toBe(false);expect(JSON.stringify(seen[0].schema)).toContain("Images attached to failed tool results are omitted");expect(JSON.stringify(seen[0].schema)).not.toContain('"name":"removed"');}
});
it.each([false,true])("throwing payload hook yields one error and no host/submission raw=%s",async raw=>{
 const {p,seen}=factory();const events=[];for await(const e of p.streamViaMuse(model,context(raw),{onPayload:async()=>{throw Error("hook denied");}}))events.push(e);
 expect(events.map((e:any)=>e.type)).toEqual(["error"]);expect((events[0] as any).error.errorMessage).toBe("hook denied");expect(seen).toEqual([]);expect(fixtureState.events).toEqual([]);
});
it.each([false,true])("response observer is awaited before text/tool normalization raw=%s",async raw=>{
 const {p}=factory();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let streamEvents=0;
 const stream=p.streamViaMuse(model,context(raw),{onResponse:async()=>{entered();await gate;},onProviderStreamEvent:async()=>{streamEvents++;}});
 const result=stream.result();await ready;expect(streamEvents).toBe(0);release();expect((await result).stopReason).toBe("stop");expect(streamEvents).toBeGreaterThan(0);
});
it.each([false,true])("throwing stream observer produces one error without normalized content raw=%s",async raw=>{
 const {p}=factory();const events=[];for await(const e of p.streamViaMuse(model,context(raw),{onProviderStreamEvent:async()=>{throw Error("stream observer denied");}}))events.push(e);
 expect(events.filter((e:any)=>e.type==="error")).toHaveLength(1);expect(events.some((e:any)=>e.type==="done")).toBe(false);expect((events.at(-1) as any).error.errorMessage).toBe("stream observer denied");
});
it("logical replacement with system-role messages fails before host rather than ignoring explicit fields",async()=>{const {p,seen}=factory();const result=await p.streamViaMuse(model,context(),{onPayload:(payload:any)=>({...payload,messages:[{role:"system",content:"ambiguous"},...payload.messages]})}).result();expect(result.stopReason).toBe("error");expect(result.errorMessage).toContain("edit logical systemPrompt and tools instead");expect(seen).toEqual([]);});
it("replacement tools-empty request takes qualified raw path",async()=>{const {p,seen}=factory();expect((await p.streamViaMuse(model,context(),{onPayload:(payload:any)=>({...payload,tools:[]})}).result()).stopReason).toBe("stop");expect(seen[0].options.purpose).toBe("raw");});
