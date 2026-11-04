import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ opens: 0, closes: 0, inputs: [] as string[] }));
vi.mock("../src/host.js", () => ({ openMuseHost: async (opts: any) => {
  state.opens++;
  return { submitInput: async (text: string) => {
    state.inputs.push(text);
    opts.onEvent({kind:"frame",frame:{method:"item/delta",params:{field:"text",delta:`reply:${text}`}}});
    opts.onEvent({kind:"terminal",status:"completed",turnId:`turn-${state.inputs.length}`});
  }, close: async () => {state.closes++;}, fence() {} };
}}));
import { createMuseProvider, streamViaMuse, setSessionManager, retireAll } from "../src/provider.js";
const model = {id:"echo",provider:"pi-muse-tether"};
const tools = [{name:"read",description:"synthetic",parameters:{type:"object",properties:{}}}];
const user = (content: string) => ({role:"user",content});
const request = (messages: any[], systemPrompt="stable") => streamViaMuse(model,{messages,tools,systemPrompt}).result();
function setup(park=true, file=true) { setSessionManager({getSessionId:()=>"completed",getSessionFile:()=>file?"synthetic.jsonl":undefined,getBranch:()=>[]},park); }
afterEach(async()=>{await retireAll();state.opens=0;state.closes=0;state.inputs=[];});
it("parks one host across completed turns, only submitting new user content",async()=>{
 setup(); const history:any[]=[];
 for (const text of ["one","two","three"]) {history.push(user(text));const result=await request(history);expect(result.stopReason).toBe("stop");history.push({...result,durationMs:123,thinkingLevel:"off"});}
 expect(state.opens).toBe(1);expect(state.closes).toBe(0);expect(state.inputs).toEqual(["one","two","three"]);
 await retireAll();expect(state.closes).toBe(1);
});
it('keeps a prompt plus before/after extension messages on the warm host',async()=>{
 setup();const initial=[user('first prompt'),user('first recall')];
 const first=await request(initial);
 const result=await request([...initial,first,user('before'),user('second prompt'),user('after')]);
 expect(result.stopReason).toBe('stop');expect(state.opens).toBe(1);expect(state.closes).toBe(0);
 expect(state.inputs).toEqual(['first prompt\nfirst recall','before\nsecond prompt\nafter']);
});
it.each(["signature","prefix"])("retires on %s mismatch and imports the current branch",async(kind)=>{
 setup();const first=await request([user("one")]);
 const messages=[user(kind==="prefix"?"changed":"one"),first,user("two")];
 const result=await request(messages,kind==="signature"?"changed":"stable");
 expect(result.stopReason).toBe("stop");
 expect(state.closes).toBe(1);expect(state.opens).toBe(2);
 expect(state.inputs[1]).toContain(kind==="prefix"?'"text":"changed"':'"text":"one"');
 expect(state.inputs[1]).toContain("NEW USER REQUEST\ntwo");
 const third=await request([...messages,result,user("three")],kind==="signature"?"changed":"stable");
 expect(third.stopReason).toBe("stop");expect(state.opens).toBe(2);expect(state.inputs[2]).toBe("three");
});
it('does not confuse a repeated extension note with the identity of a failed real prompt',async()=>{
 let attempts=0;
 const p=createMuseProvider({openHost:async(opts:any)=>({retrySafe:false,fence(){},async close(){},async submitInput(){opts.onEvent({kind:'terminal',status:++attempts===1?'failed':'completed'});}} as any)});
 let nativeUser=user('first');
 p.setSessionManager({getSessionId:()=> 'fixed-note',getSessionFile:()=> 'fixture.jsonl',getBranch:()=>[{type:'message',message:nativeUser}]});
 try {
  const first=await p.streamViaMuse(model,{messages:[user('first'),user('fixed recall')],tools}).result();
  expect(first.stopReason).toBe('error');
  const retry=await p.streamViaMuse(model,{messages:[user('first'),user('fixed recall')],tools}).result();
  expect(retry.errorMessage).toContain('no automatic resubmit');expect(attempts).toBe(1);
  const injectedRetry=await p.streamViaMuse(model,{messages:[user('first'),user('changed extension recall')],tools}).result();
  expect(injectedRetry.errorMessage).toContain('no automatic resubmit');expect(attempts).toBe(1);
  nativeUser=user('new request');
  const next=await p.streamViaMuse(model,{messages:[user('first'),user('fixed recall'),first,user('new request'),user('fixed recall')],tools}).result();
  expect(next.stopReason).toBe('stop');expect(attempts).toBe(2);
 }finally{await p.retireAll();}
});
it.each(["print","no-session"])("does not park %s, including a history import",async(kind)=>{
 setup(kind!=="print",kind!=="no-session");const result=await request([user("old"),{role:"assistant",content:[{type:"text",text:"record"}]},user("one")]);
 expect(state.inputs[0]).toContain('"text":"old"');
 expect(result.stopReason).toBe("stop");await Promise.resolve();expect(state.closes).toBe(1);
});
