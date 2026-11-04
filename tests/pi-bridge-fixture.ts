import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { registerApiDispatch } from 'pi-tether-core/register';
import { createMcpBridge } from 'pi-tether-core/mcp/bridge';

const id='bridge-fixture';
export default function(pi: any) {
 let manager: any; let bridge: any; let invocation: any; let reply: Promise<any>; let child: any;
 const log=(event: any)=>appendFileSync(process.env.BRIDGE_FIXTURE_LOG!, JSON.stringify(event)+'\n');
 pi.on('session_start', (_: any,ctx: any)=>{manager=ctx.sessionManager});
 pi.on('tool_call',(event: any)=>{if(event.toolName==='bridge_fixture_lookup')log({event:'pi_tool_call',toolCallId:event.toolCallId});});
 pi.on('tool_result',(event: any)=>{if(event.toolName==='bridge_fixture_lookup')log({event:'pi_tool_result',toolCallId:event.toolCallId});});
 pi.registerTool({name:'bridge_fixture_lookup',label:'Fixture Pi lookup',description:'Synthetic lookup',parameters:Type.Object({key:Type.String()}),
  async execute(toolCallId: string,args: any) { log({event:'executed_in_pi',pid:process.pid,toolCallId,args}); return {content:[{type:'text',text:'PI_EXECUTED_SYNTHETIC_VALUE'}],details:{}}; }});
 const stream=(model: any,context: any)=>{
  const out: any={role:'assistant',content:[],api:id,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
  const s=createAssistantMessageEventStream();
  void(async()=>{try{
   s.push({type:'start',partial:out});
   if (!bridge) {
    const params=Type.Object({key:Type.String()});
    bridge=createMcpBridge({sessionId:randomUUID(),generation:randomUUID(),tools:[{name:'bridge_fixture_lookup',description:'Synthetic lookup',inputSchema:params as unknown as Record<string, unknown>}],onInvocation:(call:any)=>{
      invocation=call;log({event:'mcp_suspended',id:call.piCallId});const toolCall={type:'toolCall' as const,id:call.piCallId,name:call.name,arguments:call.arguments};out.content.push(toolCall);out.stopReason='toolUse';s.push({type:'toolcall_start',contentIndex:0,partial:out});s.push({type:'toolcall_end',contentIndex:0,toolCall,partial:out});s.push({type:'done',reason:'toolUse',message:out});s.end();
    }});
    const d=await bridge.start();child=spawn(d.command,d.args,{env:{...process.env,...d.env},stdio:['pipe','pipe','pipe']});
    const pending=new Map<number,(x:any)=>void>();createInterface({input:child.stdout}).on('line',line=>{const x=JSON.parse(line);const resolve=pending.get(x.id);if(resolve){pending.delete(x.id);resolve(x)}});
    const rpc=(n:number,method:string,params:any)=>new Promise<any>(resolve=>{pending.set(n,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')});
    await rpc(1,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
    await rpc(2,'tools/list',{});
    reply=rpc(3,'tools/call',{name:'bridge_fixture_lookup',arguments:{key:'a'},_meta:{callId:'fixture-call'}});
   } else {
    const last=context.messages.filter((m:any)=>m.role==='toolResult' && m.toolCallId===invocation.piCallId).at(-1);
    const entry=manager.getBranch().filter((x:any)=>x.type==='message' && x.message?.role==='toolResult' && x.message.toolCallId===invocation.piCallId).at(-1);
    if(!entry || !last || JSON.stringify(last.content)!==JSON.stringify(entry.message.content))throw new Error('Pi journaled result not found or mismatch');
    log({event:'journal_found',entryId:entry.id,toolCallId:invocation.piCallId});
    bridge.journalResult({...invocation,journalEntryId:entry.id,result:{content:last.content,isError:last.isError===true}});
    const result=await reply;log({event:'mcp_response',result:result.result});
    if(result.result?.content?.[0]?.text!=='PI_EXECUTED_SYNTHETIC_VALUE')throw new Error('MCP result mismatch');
    out.content.push({type:'text',text:'PI_BRIDGE_ROUNDTRIP_OK'});s.push({type:'text_start',contentIndex:0,partial:out});s.push({type:'text_delta',contentIndex:0,delta:'PI_BRIDGE_ROUNDTRIP_OK',partial:out});s.push({type:'text_end',contentIndex:0,content:'PI_BRIDGE_ROUNDTRIP_OK',partial:out});s.push({type:'done',reason:'stop',message:out});s.end(); child.stdin.end();await bridge.retire();
   }
  }catch(e:any){out.stopReason='error';out.errorMessage=String(e?.stack||e);s.push({type:'error',reason:'error',error:out});s.end();if(child)child.stdin.end();if(bridge)await bridge.retire();}})();return s;
 };
 const template=getBuiltinModels('anthropic')[0];registerApiDispatch(id,stream);pi.registerProvider(id,{api:id,apiKey:'unused',baseUrl:id,models:[{id:'fixture',name:'Bridge fixture',reasoning:false,input:['text'],cost:template.cost,contextWindow:template.contextWindow,maxTokens:template.maxTokens}],streamSimple:stream});
}
