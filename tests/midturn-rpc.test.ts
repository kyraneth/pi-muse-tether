import {expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
it.each(['threshold','overflow'])('real Pi 1.5 RPC: %s compaction continues a completed parallel batch twice without tool replay',async(mode)=>{
 const root=await mkdtemp(join(tmpdir(),'muse-midturn-rpc-')),agent=join(root,'agent'),log=join(root,'fixture.jsonl');await mkdir(agent);
 // Exact live catalog and the account owner's benchmark trigger/keep-recent profile.
 await writeFile(join(agent,'settings.json'),JSON.stringify({compaction:{enabled:true,keepRecentTokens:32000,modelOverrides:{'pi-muse-tether/echo':{reserveTokens:607997,keepRecentTokens:32000}}},retry:{enabled:false}}));
 const child=spawn(resolve('node_modules/.bin/pi'),['-ne','-ns','-np','-nc','--no-mcp','--mode','rpc','--provider','pi-muse-tether','--model','echo','--thinking','high','--tools','batch_lookup','--session-dir',join(root,'sessions'),'-e',resolve('tests/midturn-rpc-fixture.ts')],{env:{...process.env,PI_OFFLINE:'1',PI_MUSE_TETHER_LIVE:'0',PI_CODING_AGENT_DIR:agent,MIDTURN_LOG:log,MIDTURN_MODE:mode},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',x=>stderr+=x);const queue:any[]=[],waiters:any[]=[];const wire:any[]=[];
 createInterface({input:child.stdout}).on('line',line=>{let x;try{x=JSON.parse(line);}catch{return;}wire.push(x);const w=waiters.shift();w?w(x):queue.push(x);});
 const exit=new Promise<number|null>(r=>child.once('exit',code=>{for(const w of waiters.splice(0))w(null);r(code);}));
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise<any>(r=>waiters.push(r));
 try{
  for(const round of [1,2]){
   child.stdin.write(JSON.stringify({id:String(round),type:'prompt',message:'Offline task '+round+' '+ 'earlier context '.repeat(15000)})+'\n');
   while(true){const event=await next();if(!event)throw new Error('Pi exited: '+stderr);if(event.type==='agent_settled')break;}
   const errors=wire.filter(x=>x.type==='message_end'&&x.message?.stopReason==='error');expect(errors.map(x=>x.message.errorMessage)).toEqual(mode==='overflow'?Array(round).fill('Muse context overflow: maximum context length exceeded'):[]);
   expect(wire.filter(x=>x.type==='message_end'&&Array.isArray(x.message?.content)&&x.message.content.some((p:any)=>p.text==='CONTINUATION_COMPLETE'))).toHaveLength(round);
  }
 }finally{child.stdin.end();await exit;await writeFile(join(root,'rpc.jsonl'),wire.map(x=>JSON.stringify(x)).join('\n'));}
 const events=(await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 // Parallel tools have no execution-order promise; prove each pair exactly once.
 expect(events.filter(x=>x.kind==='tool-execute').map(x=>x.key).sort()).toEqual(['a','a','b','b']);
 expect(events.filter(x=>x.kind==='commit').map(x=>[x.reason,x.tail])).toEqual([[mode,'toolResult'],[mode,'toolResult']]);
 expect(events.filter(x=>x.kind==='open-coding')).toHaveLength(3);
 expect(events.filter(x=>x.kind==='close-coding')).toHaveLength(3);
 expect(events.filter(x=>x.kind==='prior-host-receipt').every(x=>[1,2].includes(x.id))).toBe(true);
 expect(events.filter(x=>x.kind==='prior-host-receipt'&&x.id===3)).toEqual([]);
 expect(events.filter(x=>x.kind==='before-compact')[1].previousSummary).toContain('SYNTHETIC_COMPACTION_MARKER_6');
 const submits=events.filter(x=>x.kind==='submit');expect(submits).toHaveLength(4);
 expect(submits.filter(x=>String(x.text).includes('PI COMMITTED COMPACTION CONTINUATION'))).toHaveLength(2);
 console.log('MIDTURN_RPC_EVIDENCE',root);
},0);
