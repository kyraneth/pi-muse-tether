// Native Pi qualification: fixture arguments/output only; never logs general tools.
import {appendFileSync} from 'node:fs';
export default function(pi:any){
 const log=(row:any)=>appendFileSync(process.env.APPROVAL_PROOF_LOG!,JSON.stringify(row)+'\n');
 pi.registerTool({name:'bench_fixture',label:'Approval parity fixture',description:'Synthetic validation test. kind must be long-tool; count is a number.',parameters:{type:'object',properties:{kind:{type:'string',enum:['long-tool']},count:{type:'number'}},required:['kind','count'],additionalProperties:false},async execute(id:string,args:any){log({type:'execute',id,args});return {content:[{type:'text',text:'FIXTURE_OK_853'}],details:{}};}});
 pi.on('provider_stream_event',(e:any)=>{const v=e.data?.event;if(v?.kind==='tool-batch')log({type:'native-batch',calls:v.calls});});
 pi.on('tool_execution_end',(e:any)=>log({type:'tool-result',name:e.toolName,result:e.result,isError:e.isError}));
 pi.on('after_provider_response',(e:any,ctx:any)=>{if(e.status===403){log({type:'STOP_403'});ctx.abort();ctx.shutdown();}});
}
