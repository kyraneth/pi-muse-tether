import {it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
for(const phase of ['admission','terminal'])for(const raw of [false,true])it(`native Pi quota ${phase} ${raw?'raw ends without retry':'coding ends without retry and next user works'}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'muse-quota-native-')),agent=join(root,'agent'),log=join(root,'host.jsonl');await mkdir(agent);
 await writeFile(join(agent,'settings.json'),JSON.stringify({packages:[resolve('.')],retry:{enabled:true},compaction:{enabled:false}}));
 const child=spawn(resolve('node_modules/.bin/pi'),['-ne','-ns','-np','-nc','--no-mcp','--mode','rpc','--provider','pi-muse-tether','--model','echo',...(raw?['--no-tools']:['--tools','read']),'--session-dir',join(root,'sessions'),'-e',resolve('tests/r5-quota-native-fixture.ts')],{env:{...process.env,PI_OFFLINE:'1',PI_MUSE_TETHER_LIVE:'0',PI_CODING_AGENT_DIR:agent,XDG_STATE_HOME:join(root,'state'),FIXTURE_HOST_LOG:log,R5_QUOTA_PHASE:phase},stdio:['pipe','pipe','pipe']});
 const wire:any[]=[],queue:any[]=[],waiters:any[]=[];let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}wire.push(value);const waiter=waiters.shift();waiter?waiter(value):queue.push(value);});
 const exit=new Promise<number|null>(resolve=>child.once('exit',code=>{for(const w of waiters.splice(0))w(null);resolve(code);}));
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise<any>(resolve=>waiters.push(resolve));
 try {
  // Raw completion is an auxiliary one-serialized-user request, not a coding
  // conversation; normal coding cases prove the next native user can proceed.
  for(const round of raw?[1]:[1,2]) {
   child.stdin.write(JSON.stringify({id:String(round),type:'prompt',message:`Offline quota fixture user ${round}`})+'\n');
   while(true) {
    const event=await next();if(!event)throw Error('Pi exited before settled: '+stderr);
    if(event.type==='auto_retry_start')throw Error('Native Pi retried a fenced quota turn');
    if(event.type==='agent_settled')break;
   }
   const assistants=wire.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').map(e=>e.message);
   if(round===1){expect(assistants).toHaveLength(1);expect(assistants[0].stopReason).toBe('error');expect(assistants[0].errorMessage).toBe('Muse quota refused; no replay');}
   else {expect(assistants.at(-1).stopReason).toBe('stop');expect(assistants.at(-1).content.some((p:any)=>String(p.text).includes('fixture answer'))).toBe(true);}
  }
 } finally {
  // A seeded retry is a deliberate failing test, stopped immediately; never
  // sleep through Pi's own retry backoff or add a test-owned numeric limit.
  if(wire.some(e=>e.type==='auto_retry_start'))child.kill('SIGTERM');
  else child.stdin.end();
  await exit;await writeFile(join(root,'rpc.jsonl'),wire.map(e=>JSON.stringify(e)).join('\n')+'\n');await writeFile(join(root,'stderr.txt'),stderr);
 }
 const events=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 expect(events.filter(e=>e.kind==='quota')).toHaveLength(1);
 expect(events.filter(e=>e.kind==='input')).toHaveLength(raw?1:2);
 expect(events.filter(e=>e.kind==='open')).toHaveLength(raw?1:2);
 console.log('QUOTA_NATIVE_EVIDENCE',root);
},0);
