import { afterEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createReadTool, generateSummaryWithUsage, generateBranchSummary } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools, validateToolArguments } from "@earendil-works/pi-ai";
import { buildSystemPromptState } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { piContext } from "pi-tether-core/pi-context";
import { createMuseProvider } from "../src/provider.js";
import { fixtureState, openFixtureHost } from "./fixture-host.js";
const tool = createReadTool("/synthetic");
const declarations = [{name:tool.name, description:tool.description, parameters:tool.parameters}];
const user = (text:string):any => ({role:"user",content:[{type:"text",text}],timestamp:0});
const model:any = {id:"echo",provider:"pi-muse-tether",api:"offline-fixture",contextWindow:1048576,maxTokens:8192,reasoning:true};
const providers:any[]=[];
const factory=()=>{const p=createMuseProvider({openHost:openFixtureHost,promptModes:["none","replace"],promptMode:"replace",instructionMechanisms:["private-settings-fixture"],rawCompletion:true} as any);p.setSessionManager({getSessionId:()=>"pi150",getSessionFile:()=>"synthetic.jsonl",getBranch:()=>[]});providers.push(p);return p;};
const state = () => buildSystemPromptState({cwd:"/synthetic",selectedTools:[tool.name],toolSnippets:{[tool.name]:tool.description},contextFiles:[],skills:[],sections:{fixture_identity:"SYNTHETIC_IDENTITY\nΚαλημέρα\n"}});
const head = ():any => ({role:"system",...state(),toolsAdded:declarations,timestamp:0});
afterEach(async()=>{for(const p of providers)await p.retireAll();providers.length=0;fixtureState.opens=[];fixtureState.events=[];fixtureState.raw="success";fixtureState.nextId=0;});
it("Pi 1.5 native prompt and actual read schema preserve bytes, warm prefix, system/tool changes and resumed caller history",async()=>{
 const p=factory();const system=head();const messages=[system,user("one")];
 const expected=getCurrentSystemPrompt(messages);expect(expected).toContain("You are a coding assistant running inside pi, a coding agent harness.");
 expect(expected).toContain("the harness itself");expect(piContext({messages}).tools).toEqual(declarations);
 const first=await p.streamViaMuse(model,{messages},{}).result();expect(first.stopReason,first.errorMessage).toBe("stop");
 expect(fixtureState.opens[0].settings.run.system_prompt).toBe(expected);
 const config=JSON.parse(await readFile(fixtureState.opens[0].schemaPath,"utf8"));expect(config.tools).toEqual([{name:tool.name,description:expect.stringContaining(tool.description+"\n\nTransport notice:"),inputSchema:tool.parameters}]);
 expect(config.tools[0].description).toContain("[REDACTED]");expect(config.tools[0].description).toContain("omitted by the official client");
 const second=await p.streamViaMuse(model,{messages:[...messages,first,user("two")]},{}).result();expect(second.stopReason).toBe("stop");expect(fixtureState.opens).toHaveLength(1);
 const changed:any={role:"system",content:"",sections:{addendum:"CHANGED_SYSTEM\n"},timestamp:1};
 const history=[...messages,first,user("two"),second,changed,user("three")];
 expect((await p.streamViaMuse(model,{messages:history},{}).result()).stopReason).toBe("stop");expect(fixtureState.opens).toHaveLength(2);expect(fixtureState.opens[0].closed).toBe(true);expect(fixtureState.opens[1].settings.run.system_prompt).toBe(getCurrentSystemPrompt(history));
 const toolChange:any={role:"system",content:"",toolsAdded:[{...declarations[0],description:"CHANGED_DECLARATION"}],timestamp:2};
 const changedHistory=[...history,toolChange,user("four")];
 expect((await p.streamViaMuse(model,{messages:changedHistory},{}).result()).stopReason).toBe("stop");expect(fixtureState.opens).toHaveLength(3);expect(getCurrentTools(changedHistory)[0].description).toBe("CHANGED_DECLARATION");
 await p.retireAll();const resumed=factory();
 expect((await resumed.streamViaMuse(model,{messages:changedHistory},{}).result()).stopReason).toBe("stop");expect(fixtureState.opens).toHaveLength(4);expect(fixtureState.opens[3].settings.run.system_prompt).toBe(getCurrentSystemPrompt(changedHistory));
 expect(fixtureState.events.filter((x:any)=>x.kind==="input").at(-1).text).toContain("one");
 // Native validation coerces a clone; the advertised declaration itself is unchanged.
 const raw:any={id:"call",name:"read",arguments:{path:"synthetic",offset:"2",limit:"3"}};
 expect(validateToolArguments(tool,raw).offset).toBe(2);expect(raw.arguments.offset).toBe("2");expect(declarations[0].parameters).toEqual(tool.parameters);
});
it("native compaction and branch-summary constructors reach tools-empty raw lane without disturbing parked coding host",async()=>{
 const p=factory();const first=await p.streamViaMuse(model,{messages:[head(),user("one")]},{}).result();expect(first.stopReason).toBe("stop");
 const contexts:any[]=[];const stream:any=(m:any,c:any,o:any)=>{contexts.push(c);return p.streamViaMuse(m,c,o);};
 const compact=await generateSummaryWithUsage([user("COMPACT_SOURCE")],model,undefined,undefined,undefined,undefined,"PRESERVE_IDENTITY",undefined,"high",stream);
 expect(compact.text).toContain("SYNTHETIC_COMPACTION_MARKER_6");
 const branch=await generateBranchSummary([{type:"message",id:"entry",parentId:null,timestamp:new Date(0).toISOString(),message:user("BRANCH_SOURCE")} ] as any,{model,streamFn:stream,thinkingLevel:"high",signal:new AbortController().signal});
 expect(branch.error).toBeUndefined();expect(branch.summary).toContain("SYNTHETIC_COMPACTION_MARKER_6");
 expect(contexts).toHaveLength(2);
 for(const c of contexts){const normalized=piContext(c);expect(normalized.tools).toEqual([]);expect(normalized.systemPrompt).not.toBe(getCurrentSystemPrompt([head()]));}
 expect(fixtureState.opens.map((x:any)=>x.purpose)).toEqual(["coding","raw","raw"]);
 for(const raw of fixtureState.opens.slice(1)){expect(raw.schemaPath).toBeUndefined();expect(raw.settings.run.toolset).toEqual([]);expect(raw.closed).toBe(true);}
 expect(fixtureState.opens[0].closed).toBe(false);
 expect((await p.streamViaMuse(model,{messages:[head(),user("one"),first,user("after summary")]},{}).result()).stopReason).toBe("stop");expect(fixtureState.opens).toHaveLength(3);
});
