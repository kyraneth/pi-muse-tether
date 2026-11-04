import {appendFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {Type} from 'typebox';
import {registerMuseExtension} from '../index.js';
import {createMuseProvider} from '../src/provider.js';
import {openFixtureHost} from './fixture-host.js';
const record=async(x:any)=>appendFile(process.env.MIDTURN_LOG!,JSON.stringify(x)+'\n');
let coding=0;
export default async function(pi:any){
 const provider=createMuseProvider({promptModes:['none','replace'],promptMode:'replace',instructionMechanisms:['private-settings-fixture'],rawCompletion:true,toolBatches:true,openHost:async(options:any)=>{
  if(options.purpose==='raw')return openFixtureHost(options);
  const id=++coding;await record({kind:'open-coding',id,systemPrompt:options.privatePrompt?.systemPrompt});let child:any;let receipts=0;let fenced=false;
  const emit=options.onEvent;
  const host:any={batches:true,retrySafe:false,fence(reason:string){if(fenced)return;fenced=true;emit({kind:'fenced',reason});},async cancelTurn(){},async close(){
   if(child&&child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.stdin.end();await exit;}
   await record({kind:'close-coding',id});
  },async submitInput(text:any){
   await record({kind:'submit',id,text});
   if(process.env.MIDTURN_MODE==='workload'){emit({kind:'frame',frame:{method:'item/delta',params:{field:'text',delta:'WORKLOAD_COMPLETE'}}});emit({kind:'terminal',status:'completed'});return;}
   const continuation=String(text).includes('PI COMMITTED COMPACTION CONTINUATION');
   if(continuation){emit({kind:'frame',frame:{method:'item/delta',params:{field:'text',delta:'CONTINUATION_COMPLETE'}}});emit({kind:'terminal',status:'completed'});return;}
   const calls=['a','b'].map(callId=>({callId,name:'mcp__pi__batch_lookup',args:{key:callId}}));
   for(const c of calls)if(!options.validateApproval({toolName:c.name,toolCallId:c.callId,rawArgs:JSON.stringify(c.args),approvalId:c.callId,currentRequirementId:c.callId}))throw new Error('fixture approval denied');
   emit({kind:'frame',frame:{method:'session/tokenUsage',params:{sourceRange:{last:{id:'batch-'+id}},usage:{inputTokens:120,outputTokens:7,cacheReadTokens:0,cacheWriteTokens:0},totalTokens:127}}});
   emit({kind:'tool-batch',calls});
   const d=options.mcpServers.pi;child=spawn(d.command,d.args,{env:{...process.env,...d.env},stdio:['pipe','pipe','pipe']});child.stderr.resume();
   createInterface({input:child.stdout}).on('line',line=>{const f=JSON.parse(line);if(f.result){
    void record({kind:'prior-host-receipt',id,call:f.id});
    emit({kind:'frame',frame:{method:'item/completed',params:{item:{kind:'toolCall',tool:'mcp__pi__batch_lookup',callId:f.id,status:'completed',visibleOutput:f.result.content[0].text}}}});
    if(++receipts===2 && process.env.MIDTURN_MODE==='overflow')emit({kind:'terminal',status:'failed',frame:{params:{error:{message:'maximum context length exceeded'}}}});
   }});
   for(const c of calls)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:c.callId,method:'tools/call',params:{name:'batch_lookup',arguments:c.args,_meta:{callId:c.callId}}})+'\n');
  }};return host;
 }});
 await registerMuseExtension(pi,provider,{contextWindow:1007997,maxTokens:128000});
 pi.on('before_agent_start',async(event:any)=>{
  if(!process.env.MIDTURN_PREFIX_FILE)return;
  const prefix=await readFile(process.env.MIDTURN_PREFIX_FILE,'utf8').catch((error:any)=>{if(error.code==='ENOENT')return '';throw error;});
  if(prefix)return {systemPrompt:event.systemPrompt+'\n'+prefix};
 });
 pi.on('session_start',(_event:any,ctx:any)=>{
  if(_event.reason==='fork')return;
  // A preceding completed turn gives Pi's real overflow compactor history to summarize.
  const timestamp=Date.now();
  ctx.sessionManager.appendMessage({role:'user',content:[{type:'text',text:'Offline earlier task'}],timestamp});
  ctx.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:'Earlier task complete'}],api:'pi-muse-tether',provider:'pi-muse-tether',model:'echo',usage:{input:120,output:7,cacheRead:0,cacheWrite:0,totalTokens:127,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp});
 });
 pi.registerTool({name:'batch_lookup',label:'batch_lookup',description:'Offline threshold fixture',parameters:Type.Object({key:Type.String()}),async execute(_id:string,args:any){
  await record({kind:'tool-execute',key:args.key});
  // the account owner's actual 400k trigger: two results together exceed it, neither alone does.
  return {content:[{type:'text',text:args.key.repeat(process.env.MIDTURN_MODE==='overflow'?1:840000)}],details:{fixture:true}};
 }});
 pi.on('session_before_compact',async(event:any)=>{await record({kind:'before-compact',reason:event.reason,previousSummary:event.preparation.previousSummary,ends:event.preparation.messagesToSummarize?.at(-1)?.role});});
 pi.on('session_compact',async(event:any,ctx:any)=>record({kind:'commit',reason:event.reason,willRetry:event.willRetry,eventId:event.compactionEntry.id,boundary:ctx.sessionManager.getBranch().at(-1).id,tail:ctx.sessionManager.buildSessionProjection().messages.at(-1)?.role}));
}
