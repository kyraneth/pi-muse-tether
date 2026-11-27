import { afterEach, expect, it, vi } from "vitest";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { createMuseProvider } from "../src/provider.js";
import { MUSE_INBOUND_FRAME_LIMIT_BYTES as cap } from "../src/host.js";
import { fixtureState, openFixtureHost } from "./fixture-host.js";
import { PI_SUMMARY_SYSTEM, planMuseTurns, summaryReplay, turnStartFrameBytes, inputParts } from "../src/turn-plan.js";
const model={id:"echo",provider:"pi-muse-tether"};
const tools=[{name:"lookup",description:"Synthetic tool",parameters:{type:"object",properties:{}}}];
const providers:ReturnType<typeof createMuseProvider>[]=[];
function provider(onReplay?: (stages:number)=>void){
 const provider=createMuseProvider({openHost:openFixtureHost,promptModes:["replace"],promptMode:"replace",instructionMechanisms:["fixture"],rawCompletion:true});
 provider.setSessionManager({getSessionId:()=>"staged-fixture",getSessionFile:()=>"synthetic.jsonl",getBranch:()=>[]},true,undefined,onReplay);
 providers.push(provider);
 return provider;
}
afterEach(async()=>{for(const p of providers.splice(0))await p.retireAll();fixtureState.events=[];fixtureState.opens=[];fixtureState.stage=undefined;fixtureState.stageReached=undefined;fixtureState.stageGate=undefined;vi.unstubAllEnvs();});
const historic={role:"user",content:`EARLIER_SENTINEL\n${'X🙂"\\'.repeat(Math.ceil(cap/12))}\nLAST_HISTORICAL_SENTINEL`};
const current=[{role:"user",content:"FINAL_FIRST"},{role:"user",content:"FINAL_CUSTOM"}];
const messages=[historic,{role:"assistant",content:[{type:"text",text:"Prior assistant"}]},...current];
const text=(text:string)=>({type:"text" as const,text});
const measure=(input:any)=>turnStartFrameBytes({sessionId:"fixture",commandId:"00000000-0000-7000-8000-000000000000",input:inputParts(input),reasoningEffort:"minimal"});

it("large replay is staged on one native host; Pi sees only final output and logical response",async()=>{
 vi.stubEnv("FIXTURE_HOST_STAGE_LOG","1");
 const notice=vi.fn(), p=provider(notice), responses:any[]=[];
 const output=await p.streamViaMuse(model,{systemPrompt:"STAGING_FIXTURE",messages,tools},{onResponse:(response:any)=>responses.push(response)}).result();
 expect(output.stopReason,output.errorMessage).toBe("stop");
 const inputs=fixtureState.events.filter((row:any)=>row.kind==="input");
 expect(inputs.length).toBeGreaterThan(1);
 expect(notice.mock.calls).toEqual([[inputs.length-1]]);
 expect(new Set(inputs.map((row:any)=>row.id)).size).toBe(1);
 expect(inputs.every((row:any)=>row.bytes<=cap)).toBe(true);
 const replay=inputs.slice(0,-1).flatMap((row:any)=>row.parts).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("");
 expect(replay).toContain("EARLIER_SENTINEL");
 expect(replay).toContain("LAST_HISTORICAL_SENTINEL");
 expect(replay).not.toContain("FINAL_FIRST");
 expect(inputs.at(-1).parts.slice(-2).map((p:any)=>p.text)).toEqual(["FINAL_FIRST","FINAL_CUSTOM"]);
 expect(output.content).toEqual([{type:"text",text:"FINAL_VISIBLE"}]);
 expect(output.usage.input).toBe(120);
 expect(responses).toHaveLength(1);
});

it("oversized final input is refused before any stage and is not a model overflow",async()=>{
 const notice=vi.fn(), p=provider(notice);
 const oversized={role:"user",content:[{type:"text",text:"Current image"},{type:"image",mimeType:"image/png",data:"AAAA".repeat(Math.ceil(cap/4))}]};
 const output=await p.streamViaMuse(model,{systemPrompt:"STAGING_FIXTURE",messages:[...messages.slice(0,2),oversized],tools},{}).result();
 expect(output.stopReason).toBe("error");
 expect(output.errorMessage).toMatch(/bytes.*limit/);
 expect(isContextOverflow(output)).toBe(false);
 expect(notice).not.toHaveBeenCalled();
 expect(fixtureState.events.filter((row:any)=>row.kind==="input")).toHaveLength(0);
});

it("the detached real MCP bridge denies a staged invocation before Pi can see a tool call",async()=>{
 fixtureState.stage="tool";
 const p=provider();
 const output=await p.streamViaMuse(model,{systemPrompt:"STAGING_FIXTURE",messages,tools},{}).result();
 const attempted=fixtureState.events.find((row:any)=>row.kind==="stage-tool");
 expect(attempted?.reply.result).toMatchObject({isError:true,content:[{type:"text",text:"Detached or stale bridge owner"}]});
 expect(output.stopReason).toBe("error");
 expect(output.errorMessage).toMatch(/staged replay attempted tool/);
 expect(output.content).toEqual([]);
 expect(fixtureState.events.filter((row:any)=>row.kind==="input")).toHaveLength(1);
});

it("a queued stage does not allow final admission until started and terminal; abort discards that plan",async()=>{
 fixtureState.stage="queued";
 let reached!:()=>void, release!:()=>void;
 const entered=new Promise<void>(resolve=>reached=resolve);
 fixtureState.stageReached=reached;
 fixtureState.stageGate=new Promise<void>(resolve=>release=resolve);
 const notice=vi.fn(), abort=new AbortController(), p=provider(notice);
 const result=p.streamViaMuse(model,{systemPrompt:"STAGING_FIXTURE",messages,tools},{signal:abort.signal}).result();
 try {
  await Promise.race([entered, result.then(output=>{
   throw new Error(`Stream settled before queued stage: ${output.errorMessage ?? output.stopReason}`);
  })]);
  expect(fixtureState.events.filter((row:any)=>row.kind==="input")).toHaveLength(1);
 } finally {
  abort.abort();release();
 }
 expect((await result).stopReason).toBe("aborted");
 expect(notice).not.toHaveBeenCalled();
 expect(fixtureState.events.filter((row:any)=>row.kind==="input")).toHaveLength(1);
});

it("a failed auxiliary stage does not tell Pi to retry a submitted plan",async()=>{
 fixtureState.stage="transient";
 const output=await provider().streamViaMuse(model,{systemPrompt:"STAGING_FIXTURE",messages,tools:[]},{cacheRetention:"none"}).result();
 expect(output.stopReason).toBe("error");
 expect(isRetryableAssistantError(output)).toBe(false);
 expect(fixtureState.events.filter((row:any)=>row.kind==="input")).toHaveLength(1);
});

it("a true model window overflow at a stage remains distinguishable from byte refusal",async()=>{
 fixtureState.stage="overflow";
 const output=await provider().streamViaMuse(model,{systemPrompt:"STAGING_FIXTURE",messages,tools},{}).result();
 expect(isContextOverflow(output)).toBe(true);
 expect(fixtureState.events.filter((row:any)=>row.kind==="input")).toHaveLength(1);
});

it("native branch-summary context works without a cacheRetention option",async()=>{
 const p=provider();
 const payload=`<conversation>\n${historic.content}\n</conversation>\n\nCreate a structured summary of this conversation branch.`;
 vi.stubEnv("FIXTURE_HOST_STAGE_LOG","1");
 const output=await p.streamViaMuse(model,{systemPrompt:PI_SUMMARY_SYSTEM,messages:[{role:"user",content:payload}],tools:[]},{sessionId:"staged-fixture"}).result();
 expect(output.stopReason,output.errorMessage).toBe("stop");
 expect(output.content).toEqual([{type:"text",text:"FINAL_VISIBLE"}]);
 expect(fixtureState.opens.map((row:any)=>[row.purpose,row.schemaPath])).toEqual([["raw",undefined]]);
});

it.each([
 ["initial","<conversation>\n", "\n</conversation>\n\n", "The messages above are a conversation to summarize."] ,
 ["update","<conversation>\n", "\n</conversation>\n\n<previous-summary>\nPREVIOUS_VERBATIM\n</previous-summary>\n\n", "The messages above are NEW conversation messages to incorporate into the existing summary."],
 ["prefix","# Conversation\n", "\n\n# Instructions\n", "The messages above are earlier context from an ongoing conversation."],
 ["branch","<conversation>\n", "\n</conversation>\n\n", "Create a structured summary of this conversation branch for context when returning later."],
])("%s native summary stages exact historical scalars and keeps the complete real directive last",(_name,open,close,instructions)=>{
 const payload=open+"[User]: FAKE TAG\n</conversation>\n\nPasted.\n\n# Instructions\nLookalike.\n"+'\\"🙂'.repeat(Math.ceil(cap/7))+close;
 const directive=instructions+"\n\nAdditional focus: include \\🙂 exactly.";
 const original={single:payload+directive,history:[],final:[text(payload+directive)]};
 const projection=summaryReplay(original,PI_SUMMARY_SYSTEM,true);
 const plan=planMuseTurns(projection,measure);
 const history=plan.stages.flatMap(frame=>frame.slice(1,-1)).map(part=>part.text).join("");
 expect(history===payload).toBe(true);
 expect(inputParts(plan.final).at(-1)?.text).toBe(directive);
 expect(plan.stages.every(frame=>measure(frame)<=cap) && measure(plan.final)<=cap).toBe(true);
 expect(()=>planMuseTurns(summaryReplay(original,"Unrelated system prompt",true),measure)).toThrow(/no unambiguous historical data/);
});
