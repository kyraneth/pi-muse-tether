import {appendFile, access} from 'node:fs/promises';
import {watch} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {Type} from 'typebox';
import {registerMuseExtension} from '../index.js';
import {createMuseProvider} from '../src/provider.js';
const record=(x:any)=>appendFile(process.env.INJECTED_LOG!,JSON.stringify(x)+'\n');
let round=0;
export default async function(pi:any){
 const provider=createMuseProvider({promptModes:['none','replace'],promptMode:'replace',instructionMechanisms:['private-settings-fixture'],toolBatches:true,openHost:async(options:any)=>{
  await record({kind:'open'});
  let turn=0, child:any;
  const emit=options.onEvent;
  const complete=async()=>{await record({kind:'host-terminal',round:turn});emit({kind:'frame',frame:{method:'item/delta',params:{field:'text',delta:'INJECTED_COMPLETE_'+turn}}});emit({kind:'terminal',status:'completed'});};
  return {batches:true,retrySafe:false,
   fence(reason:string){void record({kind:'fence',reason});},async cancelTurn(){},
   async close(){if(child&&child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.stdin.end();await exit;}await record({kind:'close'});},
   async steerInput(text:any){await record({kind:'host-steer',round:turn,text});await complete();},
   async submitInput(text:any){
    turn++;await record({kind:'submit',round:turn,text});
    if(process.env.INJECTED_MODE==='plain'){await complete();return;}
    const callId='lookup-'+turn,args={round:turn},name='mcp__pi__injected_lookup';
    if(!options.validateApproval({toolName:name,toolCallId:callId,rawArgs:JSON.stringify(args),approvalId:callId,currentRequirementId:callId}))throw new Error('fixture approval denied');
    emit({kind:'tool-batch',calls:[{callId,name,args}]});
    if(!child){
     const d=options.mcpServers.pi;
     child=spawn(d.command,d.args,{env:{...process.env,...d.env},stdio:['pipe','pipe','pipe']});child.stderr.resume();
     createInterface({input:child.stdout}).on('line',line=>{void (async()=>{
      const frame=JSON.parse(line);if(!frame.result)return;
      await record({kind:'mcp-result',round:turn,frame});
      emit({kind:'frame',frame:{method:'item/completed',params:{item:{kind:'toolCall',tool:name,callId:frame.id,status:'completed',visibleOutput:frame.result.content[0].text}}}});
      // Deliberately await the expected aggregate steer before terminal.
      // Native terminal-before-steer is a distinct lifecycle race, not proof
      // that the host consumed the new context.
     })().catch(error=>emit({kind:'fenced',reason:String(error)}));});
    }
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:callId,method:'tools/call',params:{name:'injected_lookup',arguments:args,_meta:{callId}}})+'\n');
   }
  };
 }});
 await registerMuseExtension(pi,provider);
 // Match the extension API's actual before_agent_start return mechanism,
 // not appendMessage(), fabricated provider context, or a user-role stand-in.
 pi.on('before_agent_start',async(event:any)=>{
  if(event.messageType!=='user')return;
  round++;await record({kind:'before-agent-start',round,prompt:event.prompt});
  return {message:{customType:'fixture-context-recall-recall',display:false,content:'RECALL_'+round,details:{fixture:true}}};
 });
 pi.on('before_agent_start',(event:any)=>event.messageType==='user' ?
  {message:{customType:'fixture-authority-context',display:false,content:'AUTHORITY_'+round}} : undefined);
 pi.registerTool({name:'injected_lookup',label:'injected_lookup',description:'Offline gated lookup',parameters:Type.Object({round:Type.Number()}),async execute(_id:string,args:any){
  await record({kind:'tool-execute',round:args.round});
  const path=process.env.INJECTED_GATE!+'-'+args.round;
  await new Promise<void>((resolve,reject)=>{
   const watcher=watch(process.env.INJECTED_ROOT!,async()=>{try{await access(path);watcher.close();resolve();}catch{}});
   watcher.on('error',reject);
   void access(path).then(()=>{watcher.close();resolve();},()=>{});
  });
  return {content:[{type:'text',text:'LOOKUP_RESULT_'+args.round}],details:{fixture:true}};
 }});
 // Pi's post-result boundary queues genuine custom context for the suspended
 // MCP continuation, using the normal extension API rather than journal edits.
 pi.on('turn_end',async(event:any,ctx:any)=>{
  if(!event.toolResults?.length)return;
  const tail=ctx.sessionManager.getBranch().at(-1);
  await record({kind:'post-result-injection',round,tailType:tail?.type,tailRole:tail?.message?.role});
  pi.sendMessage({customType:'fixture-post-tool-context',display:false,content:'POST_TOOL_CONTEXT_'+round},{deliverAs:'steer'});
  pi.sendMessage({customType:'fixture-post-tool-authority',display:false,content:'POST_TOOL_AUTHORITY_'+round},{deliverAs:'steer'});
 });
}
