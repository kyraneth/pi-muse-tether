import { it, expect, afterEach, vi } from "vitest";
import { createMuseProvider } from "../src/provider.js";
import { museModelRoute } from "../src/model-route.js";
import { fixtureState, openFixtureHost } from "./fixture-host.js";
const providers:any[]=[];
afterEach(async()=>{for(const p of providers) await p.retireAll();providers.length=0;fixtureState.opens=[];fixtureState.events=[];fixtureState.raw="success";fixtureState.coding="normal";vi.unstubAllEnvs();});
const user=(content:string)=>({role:"user",content});
const tools=[{name:"read",description:"fixture",parameters:{type:"object",properties:{path:{type:"string"}}}}];
for (const id of ["muse-wonder-1.0", "muse-wonder-1.0-contributor", "muse-wonder-full-1.0", "muse-wonder-full-1.0-contributor", "muse-spark-1.3"]) {
 it(`${id} sends selected native model and tier through coding AND raw completion`,async()=>{
  vi.stubEnv("PI_MUSE_TETHER_LIVE","1");
  const opened:any[]=[];
  const p=createMuseProvider({openHost:async options=>{opened.push(options);return openFixtureHost({...options,echo:true});},promptModes:["replace"],promptMode:"replace",instructionMechanisms:["fixture"],rawCompletion:true,toolBatches:false});providers.push(p);
  p.setSessionManager({getSessionId:()=>"owner",getSessionFile:()=>"fixture",getBranch:()=>[]});
  const model={id,provider:"pi-muse-tether"};
  const first:any=await p.streamViaMuse(model,{messages:[user("one")],tools,systemPrompt:"PI"},{reasoning:"high"}).result();
  expect(first.stopReason,first.errorMessage).toBe("stop");
  const raw:any=await p.streamViaMuse(model,{messages:[user("summary")],tools:[],systemPrompt:"SUMMARY"},{reasoning:"high"}).result();
  expect(raw.stopReason,raw.errorMessage).toBe("stop");
  expect(opened.map(o=>({modelId:o.model,contributorMode:o.contributorMode}))).toEqual([museModelRoute(id),museModelRoute(id)]);
  for(const output of [first,raw]) {
   expect(output.contributorMode).toBe(museModelRoute(id)?.contributorMode);
   if(id.includes("wonder")) { expect(output.responseModel).toBeUndefined();expect(output.usage.cost.total).toBeNull(); }
  }
  // A tier switch is a new host, never reuse a parked opposite-tier process.
  if(id.includes("wonder")&&!id.endsWith("-contributor")) {
   const second:any=await p.streamViaMuse({...model,id:`${id}-contributor`},{messages:[user("one"),first,user("two")],tools,systemPrompt:"PI"},{reasoning:"high"}).result();
   expect(second.stopReason,second.errorMessage).toBe("stop");
   expect(opened).toHaveLength(3);expect(opened[2].contributorMode).toBe("on");
   expect(fixtureState.opens[0].closed).toBe(true);
  }
 });
}
