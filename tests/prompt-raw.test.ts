import {afterEach,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
// The fixture deliberately holds the coding host before its first schema read.
it("startup schema read cannot be replaced by concurrent tools-empty summary",async()=>{
 const p=factory();let release!:()=>void;
 fixtureState.codingReadHold=new Promise<void>(resolve=>release=resolve);
 let opened!:(value:any)=>void;const opening=new Promise<any>(resolve=>opened=resolve);
 fixtureState.codingBeforeRead=opened;
 const coding=call(p,[user("one")]);const staged=await opening;
 const original=await readFile(staged.schemaPath);const originalSettings=await readFile(staged.path);
 try {
  const summary=await call(p,[user("summarize separately")],"EXACT_SUMMARY",[],{sessionId:"owner"});
  expect(summary.stopReason).toBe("stop");expect(await readFile(staged.schemaPath)).toEqual(original);expect(await readFile(staged.path)).toEqual(originalSettings);
 } finally {release();await coding;}
 expect((await coding).stopReason).toBe("stop");
 const c=fixtureState.opens.find((o:any)=>o.purpose==='coding');expect(c.schemaHash).toBe(createHash('sha256').update(original).digest('hex'));
});
import {createMuseProvider} from "../src/provider.js";
import {fixtureState,openFixtureHost} from "./fixture-host.js";
const model:any={id:"echo",provider:"pi-muse-tether"};
const tools=[{name:"read",description:"synthetic",parameters:{type:"object",properties:{path:{type:"string"}}}}];
const user=(content:string)=>({role:"user",content});
const providers:any[]=[];
const factory=(qualified=true)=>{
 const p=createMuseProvider({openHost:openFixtureHost,...(qualified?{promptModes:["none","replace"] as any,promptMode:"replace" as any,instructionMechanisms:["private-settings-fixture"],rawCompletion:true}:{})});
 p.setSessionManager({getSessionId:()=>"owner",getSessionFile:()=>"synthetic.jsonl",getBranch:()=>[]});providers.push(p);return p;
};
const call=(p:any,messages:any[],systemPrompt="EXACT_PI_PROMPT\nkeep all bytes",declarations:any[]=tools,options={})=>p.streamViaMuse(model,{messages,tools:declarations,systemPrompt},options).result();
afterEach(async()=>{for(const p of providers)await p.retireAll();providers.length=0;fixtureState.raw="success";fixtureState.coding="normal";fixtureState.opens=[];fixtureState.events=[];fixtureState.rawHold=undefined;fixtureState.rawStarted=undefined;fixtureState.codingBeforeRead=undefined;fixtureState.codingReadHold=undefined;fixtureState.nextId=0;fixtureState.reviewer=undefined;fixtureState.codingCloseHold=undefined;fixtureState.codingCloseStarted=undefined;});
it("qualified fixture sends exact prompt; changes retire and do not reuse stale settings",async()=>{
 const p=factory();const first=await call(p,[user("one")]);
 expect(first.stopReason,first.errorMessage).toBe("stop");expect(fixtureState.opens[0].settings.run.system_prompt).toBe("EXACT_PI_PROMPT\nkeep all bytes");
 await call(p,[user("one"),first,user("two")],"CHANGED_PROMPT\n");
 expect(fixtureState.opens).toHaveLength(2);expect(fixtureState.opens[0].closed).toBe(true);expect(fixtureState.opens[1].settings.run.system_prompt).toBe("CHANGED_PROMPT\n");
});
it("shutdown still awaits an already-retiring binding's actual cleanup",async()=>{
 const p=factory();await call(p,[user("one")]);const coding=fixtureState.opens[0];
 let release!:()=>void,started!:()=>void;fixtureState.codingCloseHold=new Promise<void>(r=>release=r);const entered=new Promise<void>(r=>started=r);fixtureState.codingCloseStarted=started;
 const first=p.retireAll();let observedCleanup=false;
 try {await entered;const second=p.retireAll().then(()=>{observedCleanup=coding.cleaned===true;});release();await Promise.all([first,second]);expect(observedCleanup).toBe(true);}
 finally{release();await first;}
});
it("private recipe refuses an automated reviewer before submitting model work",async()=>{
 const p=factory();fixtureState.reviewer="autoReview";
 const result=await call(p,[user("one")]);expect(result.stopReason).toBe("error");expect(result.errorMessage).toContain("verified human reviewer");
 expect(fixtureState.events.filter((e:any)=>e.kind==="input")).toHaveLength(0);
});
it("tools-empty summary routing id may equal coding owner and never touches that binding",async()=>{
 const p=factory();const first=await call(p,[user("one")]);
 const summary=await call(p,[user("serialized summary request")],"EXACT_SUMMARIZER",[],{sessionId:"owner"});
 expect(summary.stopReason).toBe("stop");expect(summary.content).toHaveLength(1);expect(summary.content[0].type).toBe("text");expect(summary.usage.input).toBe(120);expect(summary.usage.output).toBe(7);
 expect(fixtureState.opens.map((o:any)=>o.purpose)).toEqual(["coding","raw"]);
 expect(fixtureState.opens[1].closed).toBe(true);expect(fixtureState.opens[1].schemaPath).toBeUndefined();expect(fixtureState.opens[1].settings.run.toolset).toEqual([]);expect(fixtureState.opens[0].closed).toBe(false);
 await call(p,[user("one"),first,user("two")]);expect(fixtureState.opens).toHaveLength(2);
});
it.each(["helper","tool","failure","no-usage"])("summary %s fails without retiring coding host",async(kind)=>{
 const p=factory();const first=await call(p,[user("one")]);fixtureState.raw=kind;
 const summary=await call(p,[user("summarize")],"SUMMARIZER",[],{sessionId:"different-routing-id"});
 expect(summary.stopReason).toBe("error");expect(summary.content).toEqual([]);expect(fixtureState.opens[0].closed).toBe(false);
 expect((await call(p,[user("one"),first,user("two")])).stopReason).toBe("stop");expect(fixtureState.opens).toHaveLength(2);
});
it("unqualified tools-empty refusal leaves an existing coding host parked",async()=>{
 const p=factory(false);const first=await call(p,[user("one")]);
 expect((await call(p,[user("summarize")],"SUMMARY",[])).stopReason).toBe("error");
 expect(fixtureState.opens).toHaveLength(1);expect(fixtureState.opens[0].closed).toBe(false);
 await call(p,[user("one"),first,user("two")]);expect(fixtureState.opens).toHaveLength(1);
});
it("concurrent raw summary cannot overwrite coding settings or schema during startup/use",async()=>{
 const p=factory();const first=await call(p,[user("one")]);const coding=fixtureState.opens[0];
 const before=await readFile(coding.path);const schemaBefore=await readFile(coding.schemaPath);
 let release!:()=>void;fixtureState.rawHold=new Promise<void>(resolve=>release=resolve);
 const started=new Promise<void>(resolve=>fixtureState.rawStarted=resolve);
 const summary=call(p,[user("summarize")],"SEPARATE_SUMMARIZER",[],{sessionId:"owner"});
 await started;
 try {
  const second=await call(p,[user("one"),first,user("two")]);expect(second.stopReason).toBe("stop");
  expect(await readFile(coding.path)).toEqual(before);expect(await readFile(coding.schemaPath)).toEqual(schemaBefore);
  expect(fixtureState.opens[1].path).not.toBe(coding.path);expect(fixtureState.opens[1].schemaPath).toBeUndefined();
 } finally {release();await summary;}
 expect((await summary).stopReason).toBe("stop");
});
