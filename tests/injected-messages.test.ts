import {expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

it.each(['plain','mcp-steering'])('real Pi RPC: %s keeps extension custom context current across a warm turn',async(mode)=>{
 const root=await mkdtemp(join(tmpdir(),'muse-injected-messages-')),agent=join(root,'agent'),log=join(root,'fixture.jsonl'),sessions=join(root,'sessions');
 await mkdir(agent);const emptyAuth=join(agent,'auth.json');await writeFile(emptyAuth,'{}');
 await writeFile(join(agent,'settings.json'),JSON.stringify({compaction:{enabled:false},retry:{enabled:false}}));
 const child=spawn(resolve('node_modules/.bin/pi'),['-ne','-ns','-np','-nc','--no-mcp','--mode','rpc','--provider','pi-muse-tether','--model','echo','--tools','injected_lookup','--session-dir',sessions,'-e',resolve('tests/injected-messages-fixture.ts')],{
  env:{...process.env,PI_OFFLINE:'1',PI_MUSE_TETHER_LIVE:'0',PI_CODING_AGENT_DIR:agent,INJECTED_EMPTY_AUTH:emptyAuth,INJECTED_BLOCKED:join(root,'blocked.log'),INJECTED_LOG:log,INJECTED_MODE:mode,INJECTED_GATE:join(root,'gate'),INJECTED_ROOT:root,NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import '+resolve('tests/injected-messages-offline.mjs')].filter(Boolean).join(' ')},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',x=>stderr+=x);
 const wire:any[]=[],queue:any[]=[],waiters:any[]=[];
 createInterface({input:child.stdout}).on('line',line=>{let x;try{x=JSON.parse(line);}catch{return;}wire.push(x);const w=waiters.shift();w?w(x):queue.push(x);});
 const exit=new Promise<number|null>(r=>child.once('exit',code=>{for(const w of waiters.splice(0))w(null);r(code);}));
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise<any>(r=>waiters.push(r));
 const send=(x:any)=>child.stdin.write(JSON.stringify(x)+'\n');
 try{
  send({id:'steering-mode',type:'set_steering_mode',mode:'all'});
  for(const round of [1,2]){
   send({id:'prompt-'+round,type:'prompt',message:'CURRENT_PROMPT_'+round});
   let steered=false;
   while(true){
    const event=await next();if(!event)throw new Error('Pi exited: '+stderr);
    if(event.type==='tool_execution_start')send({id:'steer-'+round,type:'steer',message:'USER_STEERING_'+round});
    if(event.type==='response'&&event.id==='steer-'+round){expect(event.success).toBe(true);steered=true;await writeFile(join(root,'gate-'+round),'release');}
    if(event.type==='agent_settled')break;
   }
   expect(steered).toBe(mode==='mcp-steering');
   expect(wire.filter(x=>x.type==='message_end'&&x.message?.stopReason==='error').map(x=>x.message.errorMessage)).toEqual([]);
   expect(wire.filter(x=>x.type==='message_end'&&x.message?.content?.some?.((p:any)=>p.text==='INJECTED_COMPLETE_'+round))).toHaveLength(1);
  }
 }finally{child.stdin.end();await exit;await writeFile(join(root,'rpc.jsonl'),wire.map(x=>JSON.stringify(x)).join('\n'));}
 const events=(await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 expect(events.filter(x=>x.kind==='open')).toHaveLength(1);
 expect(events.filter(x=>x.kind==='close')).toHaveLength(1);
 expect(events.filter(x=>x.kind==='fence')).toEqual([]);
 expect(events.filter(x=>x.kind==='submit').map(x=>x.text)).toEqual(['CURRENT_PROMPT_1\nRECALL_1\nAUTHORITY_1','CURRENT_PROMPT_2\nRECALL_2\nAUTHORITY_2']);
 const files=(await readdir(sessions)).filter(x=>x.endsWith('.jsonl'));expect(files).toHaveLength(1);
 const journal=(await readFile(join(sessions,files[0]),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 expect(journal.filter(x=>x.type==='custom_message'&&x.customType==='fixture-context-recall-recall').map(x=>[x.content,x.display])).toEqual([['RECALL_1',false],['RECALL_2',false]]);
 expect(journal.filter(x=>x.type==='custom_message'&&x.customType==='fixture-authority-context').map(x=>x.content)).toEqual(['AUTHORITY_1','AUTHORITY_2']);
 if(mode==='mcp-steering'){
  expect(events.filter(x=>x.kind==='tool-execute').map(x=>x.round)).toEqual([1,2]);
  expect(events.filter(x=>x.kind==='post-result-injection').map(x=>[x.tailType,x.tailRole])).toEqual([['message','toolResult'],['message','toolResult']]);
  expect(events.filter(x=>x.kind==='host-steer').map(x=>x.text)).toEqual(['USER_STEERING_1\nPOST_TOOL_CONTEXT_1\nPOST_TOOL_AUTHORITY_1','USER_STEERING_2\nPOST_TOOL_CONTEXT_2\nPOST_TOOL_AUTHORITY_2']);
  expect(events.filter(x=>x.kind==='mcp-result').map(x=>x.frame.result.content)).toEqual([[{type:'text',text:'LOOKUP_RESULT_1'}],[{type:'text',text:'LOOKUP_RESULT_2'}]]);
  expect(journal.filter(x=>x.type==='custom_message'&&x.customType.startsWith('fixture-post-tool-')).map(x=>x.content)).toEqual(['POST_TOOL_CONTEXT_1','POST_TOOL_AUTHORITY_1','POST_TOOL_CONTEXT_2','POST_TOOL_AUTHORITY_2']);
  for(const round of [1,2]){
   const receipt=events.findIndex(x=>x.kind==='mcp-result'&&x.round===round);
   const steer=events.findIndex(x=>x.kind==='host-steer'&&x.round===round);
   const terminal=events.findIndex(x=>x.kind==='host-terminal'&&x.round===round);
   expect(receipt).toBeGreaterThan(-1);expect(steer).toBeGreaterThan(receipt);expect(terminal).toBeGreaterThan(steer);
   const result=journal.findIndex(x=>x.type==='message'&&x.message?.role==='toolResult'&&x.message.content?.[0]?.text==='LOOKUP_RESULT_'+round);
   const custom=journal.findIndex(x=>x.type==='custom_message'&&x.content==='POST_TOOL_CONTEXT_'+round);
   expect(result).toBeGreaterThan(-1);expect(custom).toBeGreaterThan(result);
  }
 }
 expect(await readFile(join(root,'blocked.log'),'utf8').catch((e:any)=>{if(e.code==='ENOENT')return '';throw e;})).toBe('');
 console.log('INJECTED_MESSAGES_EVIDENCE',mode,root);
},0);
