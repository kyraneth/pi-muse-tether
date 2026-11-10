import {afterEach,describe,expect,it} from 'vitest';
import {Connection} from '@muse-code/sdk';
import {Agent} from '@earendil-works/pi-agent-core';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
const wire=JSON.parse(await readFile(new URL('./fixtures/invalid-batch.json',import.meta.url),'utf8'));
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MuseHost} from '../src/host.js';
import {createMuseProvider} from '../src/provider.js';
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {resolve,promise};};
class Frames{
 values:any[]=[];waiters:any[]=[];
 push(f:any){const v={done:false,value:JSON.stringify(f)+'\n'},w=this.waiters.shift();w?w(v):this.values.push(v);}
 end(){const v={done:true},w=this.waiters.shift();w?w(v):this.values.push(v);}
 [Symbol.asyncIterator](){return {next:()=>Promise.resolve(this.values.shift()??new Promise(r=>this.waiters.push(r)))};}
}
let cleanup:undefined|(()=>Promise<void>);
afterEach(async()=>{await cleanup?.();cleanup=undefined;});
async function fixture(mode='normal'){
 const root=await mkdtemp(join(tmpdir(),'muse-pi-validation-'));await mkdir(root,{recursive:true});
 const state:any={runs:[],results:[],commands:[],decisions:[],batches:[]};
 const tools=[{name:'work',label:'work',description:'Synthetic Pi validation',parameters:{type:'object',properties:{kind:{type:'string',enum:['ok']},count:{type:'number'}},required:['kind','count'],additionalProperties:false},async execute(_id:string,args:any){state.runs.push(args);return {content:[{type:'text',text:'REPAIRED_853'}],details:{}};}}];
 const invalid={call_id:'invalid',name:'mcp__pi__work',args:JSON.stringify({kind:'bad',count:7})};
 const repair={call_id:'repair',name:'mcp__pi__work',args:JSON.stringify({kind:'ok',count:'7'})};
 const children:any[]=[];let host:MuseHost,turnId:string;
 const provider=createMuseProvider({toolBatches:true,openHost:async options=>{
  const frames=new Frames(),decisions=new Map<string,ReturnType<typeof deferred>>();
  const reply=(f:any,result:any)=>frames.push({jsonrpc:'2.0',id:f.id,result});
  const notify=(method:string,params:any)=>frames.push({jsonrpc:'2.0',method,params:{sessionId:'fixture',turnId,sourceRange:{first:{id:method,sequence:1},last:{id:method,sequence:1},stream:{kind:'session',id:'fixture'}},viewCursor:method,...params}});
  const commit=(calls:any[])=>{state.batches.push(calls);const f=structuredClone(wire.frames.invalidCommit);f.params.record.payload.run_id=turnId;f.params.record.payload.event.tool_calls=calls;frames.push(f);};
  const approve=(call:any)=>{const d=deferred();decisions.set(call.call_id,d);frames.push({jsonrpc:'2.0',id:call.call_id==='invalid'?101:102,method:'approval/request',params:{...wire.frames.invalidApproval.params,sessionId:'fixture',turnId,approvalId:call.call_id,itemId:call.call_id,taskId:call.call_id,toolCallId:call.call_id,toolName:call.name,rawArgs:call.args,subject:{kind:'tool',toolName:call.name},currentRequirementId:{approvalId:call.call_id,sourceIndex:0},availableChoices:[{choiceId:'allow_once',decision:'approved',scope:'once',label:'Allow once'},{choiceId:'abort',decision:'abort',scope:'once',label:'Reject'}]}});return d.promise;};
  const invoke=async(call:any)=>{
   const approved=await approve(call);state.decisions.push(approved);
   if(approved!=='allow_once'){notify('turn/completed',{terminal:'completed'});return;}
   const descriptor=options.mcpServers!.pi as any;
   const child=spawn(descriptor.command,descriptor.args,{env:{...process.env,...descriptor.env},stdio:['pipe','pipe','pipe']});children.push(child);child.stderr.resume();
   const done=deferred();
   createInterface({input:child.stdout}).on('line',line=>{const f=JSON.parse(line);if(f.id!==call.call_id)return;state.results.push(f.result);
    const text=f.result.content.map((c:any)=>c.text).join('\n');
    notify('item/completed',{item:{kind:'toolCall',tool:call.name,args:mode==='wrong-args'?JSON.stringify({kind:'changed',count:7}):call.args,callId:call.call_id,itemId:call.call_id,revision:2,turnId,status:f.result.isError?'failed':'completed',...(f.result.isError?{failureReason:text,visibleOutput:'tool failed: '+text}:{visibleOutput:mode==='wrong-output'?'seeded wrong body':text})}});done.resolve(undefined);
   });
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:call.call_id,method:'tools/call',params:{name:'work',arguments:JSON.parse(call.args),_meta:{callId:call.call_id}}})+'\n');
   await done.promise;
  };
  const drive=async()=>{
   if(mode==='mixed'){commit([invalid,repair]);await invoke(invalid);await invoke(repair);}
   else{commit([invalid]);await invoke(invalid);if(host.fencedReason)return;commit([repair]);await invoke(repair);}
   notify('turn/completed',{terminal:'completed'});
  };
  const connection=new Connection({incoming:frames,async write(chunk:string){const f=JSON.parse(chunk),p=f.params??{};state.commands.push(f);
      // Real 1.4.14 answers the 1.4.15 session-MCP inventory query methodNotFound.
      if (f.method === "mcpServer/readInventory") { frames.push({jsonrpc:"2.0",id:f.id,error:{code:-32601,message:"method not found",data:{kind:"methodNotFound",retryable:false}}}); return; }
   if(f.method==='session/start')reply(f,{session:{sessionId:'fixture'},viewCursor:'0'});
   else if(f.method==='log/streams')reply(f,{streams:[{stream:{kind:'session.live',id:'fixture'}}]});
   else if(f.method==='log/subscribe')reply(f,{subscriptionId:1});
   else if(f.method==='approval/decide'){reply(f,{commandId:p.commandId,status:'accepted',terminal:false});decisions.get(p.approvalId)?.resolve(p.choiceId);}
   else if(f.method==='turn/cancel'){reply(f,{commandId:p.commandId,status:'accepted'});notify('turn/completed',{terminal:'cancelled'});}
   else if(f.method==='turn/start'){turnId=p.commandId;reply(f,{commandId:p.commandId,status:'accepted',disposition:'started',turnId,startedNewTurn:true});notify('turn/started',{commandId:p.commandId});void drive().catch(error=>host.fence(error.message));}
  },close(){frames.end();}});
  host=new MuseHost(connection,{sessionDurability:'ephemeral',grantedCapabilities:['sessionMcp','rawLog']} as any,options,async()=>{for(const d of decisions.values())d.resolve('abort');for(const child of children){const done=child.exitCode===null?new Promise(r=>child.once('exit',r)):Promise.resolve();child.stdin.end();await done;}await connection.close();});return host.open();
 }});
 const manager=SessionManager.create(root,root);provider.setSessionManager(manager);
 const agent=new Agent({initialState:{model:{id:'echo',provider:'pi-muse-tether'} as any,tools},streamFn:provider.streamViaMuse});
 agent.subscribe(e=>{if(e.type==='message_end')manager.appendMessage(e.message as any);});
 cleanup=async()=>{await provider.retireAll();await rm(root,{recursive:true,force:true});};
 return {state,agent,host:()=>host,run:()=>agent.prompt({role:'user',content:'Synthetic validation repair',timestamp:1})};
}
describe('Pi owns validation; real SDK, MCP and Pi agent boundary',()=>{
 it.each(['normal','mixed'])('returns actual validation error then coerces repair without changing native identity: %s',async mode=>{
  const f=await fixture(mode);await f.run();
  expect(f.host().fencedReason).toBeUndefined();
  expect(f.state.decisions).toEqual(['allow_once','allow_once']);
  expect(f.state.runs).toEqual([{kind:'ok',count:7}]);
  const results=f.agent.state.messages.filter((m:any)=>m.role==='toolResult');
  expect(results).toHaveLength(2);expect(results[0].isError).toBe(true);expect(results[0].content[0].text).toContain('Validation failed for tool "work"');
  expect(results[1].content[0].text).toBe('REPAIRED_853');expect(results[1].isError).toBe(false);
  expect(f.state.results.map((r:any)=>r.content)).toEqual(results.map((r:any)=>r.content));
  expect(f.agent.state.messages.filter((m:any)=>m.role==='assistant').flatMap((m:any)=>m.content).find((c:any)=>c.type==='toolCall'&&c.arguments.kind==='ok').arguments.count).toBe('7');
  expect(f.agent.state.messages.at(-1).stopReason).toBe('stop');
  expect(f.state.commands.filter((c:any)=>c.method==='turn/start')).toHaveLength(1);
 });
 it.each(['wrong-args','wrong-output'])('still fences seeded native mismatch: %s',async mode=>{
  const f=await fixture(mode);await f.run();
  expect(f.agent.state.messages.at(-1).stopReason).toBe('error');
  expect(f.agent.state.messages.at(-1).errorMessage).toMatch(/differ|mismatch/i);
  expect(f.state.runs).toEqual(mode==='wrong-output'?[{kind:'ok',count:7}]:[]);
 });
});
