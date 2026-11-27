import {expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {MUSE_INBOUND_FRAME_LIMIT_BYTES as cap} from '../src/host.js';

it('native Pi RPC stages oversized historical context, not an oversized new user frame',async()=>{
 const root=await mkdtemp(join(tmpdir(),'muse-frame-limit-rpc-')),agent=join(root,'agent'),log=join(root,'fixture.jsonl');await mkdir(agent);
 await writeFile(join(agent,'settings.json'),JSON.stringify({compaction:{enabled:false},retry:{enabled:false}}));
 const child=spawn(resolve('node_modules/.bin/pi'),['-ne','-ns','-np','-nc','--no-mcp','--no-tools','--mode','rpc','--provider','pi-muse-tether','--model','echo','--session-dir',join(root,'sessions'),'-e',resolve('tests/tool-free-entry.ts')],{
  env:{...process.env,HOME:root,PI_OFFLINE:'1',PI_MUSE_TETHER_LIVE:'0',PI_CODING_AGENT_DIR:agent,XDG_STATE_HOME:join(root,'state'),PI_MUSE_TETHER_LEDGER_ORIGIN:'test',FIXTURE_HOST_LOG:log,FIXTURE_HOST_STAGE_LOG:'1',FIXTURE_STAGE_HISTORY:'1'},stdio:['pipe','pipe','pipe'],
 });
 let stderr='';child.stderr.on('data',x=>stderr+=x);const wire:any[]=[];
 const exit=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});
 const send=(id:string,message:string)=>child.stdin.write(JSON.stringify({id,type:'prompt',message})+'\n');
 child.stdin.on('error',()=>{});
 try{
  send('first','FINAL_USER_DIRECTIVE');
  let ended=0;
  for await (const line of createInterface({input:child.stdout})) {
   let event;try {event=JSON.parse(line);} catch {continue;}
   wire.push(event);
   if(event.type==='response'&&!event.success) throw Error(event.error);
   if(event.type!=='agent_settled')continue;
   if(++ended===2) break;
   send('oversized','x'.repeat(cap));
  }
 }finally{child.stdin.end();await exit;}
 expect(await exit,stderr).toBe(0);
 expect(wire.filter(event=>event.type==='agent_settled')).toHaveLength(2);
 const assistant=wire.filter(event=>event.type==='message_end'&&event.message?.role==='assistant').map(event=>event.message);
 expect(assistant.map(message=>message.stopReason)).toEqual(['stop','error']);
 expect(assistant[0].content).toEqual([{type:'text',text:'FINAL_VISIBLE'}]);
 expect(assistant[1].errorMessage).toMatch(/bytes; the client limit/);
 expect(wire.some(event=>event.type==='compaction_start' && event.reason==='overflow')).toBe(false);
 const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const inputs=records.filter(row=>row.kind==='input');
 expect(inputs.length).toBeGreaterThan(1);
 expect(new Set(inputs.map(row=>row.id)).size).toBe(1);
 expect(inputs.every(row=>row.bytes<=cap)).toBe(true);
 const history=inputs.slice(0,-1).flatMap(row=>row.parts.slice(1,-1)).map(part=>part.text??'').join('');
 expect(history).toContain('EARLIER_CONTEXT_SENTINEL');
 expect(history).toContain('TOOL_RESULT_SENTINEL');
 expect(history).toContain('HISTORICAL_ASSISTANT_SENTINEL');
 expect(history).not.toContain('FINAL_USER_DIRECTIVE');
 expect(inputs.at(-1).parts.slice(-1)[0].text).toBe('FINAL_USER_DIRECTIVE');
});
