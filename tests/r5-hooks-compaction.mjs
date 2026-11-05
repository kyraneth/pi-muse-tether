// Native Pi manual compaction evidence for the installed Pi hook-forwarding limit.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('..','hooks-native-compact'),agent=join(root,'agent'),pkg=join(root,'package'),log=join(root,'hooks.jsonl'),hostLog=join(root,'host.jsonl');
await mkdir(agent,{recursive:true});await mkdir(pkg,{recursive:true});
await writeFile(join(pkg,'package.json'),JSON.stringify({name:'muse-hook-compact-fixture',pi:{extensions:[resolve('tests/r5-hooks-fixture.ts')]}}));
await writeFile(join(agent,'settings.json'),JSON.stringify({packages:[pkg],extensions:[resolve('tests/r5-hooks-observer.ts'),resolve('tests/compact-fixture.ts')],defaultProvider:'pi-muse-tether',defaultModel:'echo'}));await writeFile(log,'');await writeFile(hostLog,'');
const child=spawn(process.execPath,['node_modules/@earendil-works/pi-coding-agent/dist/cli.js','--offline','--mode','rpc','--no-session','--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider','pi-muse-tether','--model','echo','--tools','read','--system-prompt','Compaction qualification fixture'],{cwd:resolve('.'),env:{...process.env,PI_CODING_AGENT_DIR:agent,XDG_STATE_HOME:join(root,'state'),PI_MUSE_TETHER_LIVE:'0',MUSE_HOOK_LOG:log,FIXTURE_HOST_LOG:hostLog,COMPACT_HOOK_MARKER:join(root,'compact-event.txt')},stdio:['pipe','pipe','pipe']});
let stderr='',pending='';const wire=[];let finish,reject;const response=new Promise((r,j)=>{finish=r;reject=j;});
child.stderr.on('data',d=>stderr+=d);child.stdout.on('data',d=>{pending+=d;let end;while((end=pending.indexOf('\n'))!==-1){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;try{const event=JSON.parse(line);wire.push(event);if(event.type==='response'&&event.id==='manual-compact')finish(event);}catch(error){reject(error);}}});
const exited=new Promise((r,j)=>{child.on('error',j);child.on('close',code=>{reject(Error('Pi exited before compact response: '+stderr));r(code);});});
child.stdin.write(JSON.stringify({id:'manual-compact',type:'compact',customInstructions:'Preserve the synthetic task.'})+'\n');
let result;try{result=await response;}finally{child.stdin.end();await exited;await writeFile(join(root,'rpc.jsonl'),wire.map(e=>JSON.stringify(e)).join('\n')+'\n');await writeFile(join(root,'err.txt'),stderr);}
assert.equal(result.success,true,result.error);assert.ok(result.data.summary.includes('SYNTHETIC_COMPACTION_MARKER_6'));
const rows=(await readFile(hostLog,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));assert.ok(rows.some(r=>r.kind==='open'&&r.purpose==='raw'));assert.ok(rows.some(r=>r.kind==='input'&&r.purpose==='raw'));
assert.equal((await readFile(log,'utf8')).trim(),'','Installed Pi unexpectedly forwards compaction hooks: update documented limit and qualify new behavior');
assert.equal(await readFile(join(root,'compact-event.txt'),'utf8'),'manual');
console.log(JSON.stringify({result:'PASS',manualCompaction:true,rawSdkSubmission:true,extensionProviderHooks:0,limit:'Pi1.5.0 createSummarizationOptions omits instrumentation callbacks',evidence:root}));
