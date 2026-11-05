// Run from repo root. Native Pi CLI + discovered local path package; no API calls.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const live=process.argv.includes('--live');
const home=resolve('..','hooks-native-'+(live?'live':'offline'));
await mkdir(home,{recursive:true});
const fixturePackage=join(home,'package');await mkdir(fixturePackage,{recursive:true});
await writeFile(join(fixturePackage,'package.json'),JSON.stringify({name:'muse-hook-offline-path-fixture',pi:{extensions:[resolve('tests/r5-hooks-fixture.ts')]}}));
for(const raw of process.argv.includes('--raw-only')?[true]:process.argv.includes('--coding-only')?[false]:[false,true]){
 const name=raw?'raw':'coding',agent=join(home,name,'agent');await mkdir(agent,{recursive:true});
 await writeFile(join(agent,'settings.json'),JSON.stringify({packages:[live?resolve('.'):fixturePackage],extensions:[resolve('tests/r5-hooks-observer.ts')],enabledModels:['pi-muse-tether/*'],defaultProvider:'pi-muse-tether',defaultModel:live?'muse-wonder-1.0-contributor':'echo'}));
 const log=join(home,name,'hooks.jsonl'),hostLog=join(home,name,'host.jsonl');await writeFile(log,'');await writeFile(hostLog,'');
 const args=['node_modules/@earendil-works/pi-coding-agent/dist/cli.js','--offline','--mode','json','--no-session','--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider','pi-muse-tether','--model',live?'muse-wonder-1.0-contributor':'echo','--system-prompt','Reply exactly as requested.',...(raw?['--no-tools']:['--tools','read,hook_removed']),'ORIGINAL_SHOULD_NOT_REACH_HOST'];
 const child=spawn(process.execPath,args,{cwd:resolve('.'),env:{...process.env,PI_CODING_AGENT_DIR:agent,XDG_STATE_HOME:join(home,name,'state'),PI_MUSE_TETHER_LIVE:live?'1':'0',PI_MUSE_TETHER_SYSTEM_PROMPT:'replace',MUSE_HOOK_LOG:log,FIXTURE_HOST_LOG:hostLog},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r);});
 await writeFile(join(home,name,'out.jsonl'),stdout);await writeFile(join(home,name,'err.txt'),stderr);
 const rows=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
 const events=stdout.split('\n').filter(Boolean).map(s=>JSON.parse(s));
 const messages=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').map(e=>e.message);
 if(messages.some(m=>/403|client_attestation_denied/.test(m.errorMessage??'')))throw Error('STOP: real vendor refusal; no replay');
 assert.equal(code,0,stderr);assert.ok(rows.some(r=>r.kind==='payload'),'payload hook absent');assert.ok(rows.some(r=>r.kind==='response'),'response hook absent');assert.ok(rows.some(r=>r.kind==='stream'),'stream hook absent');
 assert.equal(rows.find(r=>r.kind==='response').status,0);assert.equal(rows.find(r=>r.kind==='response').headers['x-pi-tether-response'],'logical-admission');
 assert.ok(rows.findIndex(r=>r.kind==='response')<rows.findIndex(r=>r.kind==='stream'),'stream before response');assert.ok(!rows.some(r=>r.kind==='removed-tool-executed'));
 assert.ok(messages.length>0);for(const m of messages)assert.ok(!['error','aborted'].includes(m.stopReason),m.errorMessage);
 if(live)assert.ok(messages.some(m=>m.content.some(c=>c.type==='text'&&c.text.includes('HOOK_REPLACED_14'))),'replacement did not reach model');
 else {const hostRows=(await readFile(hostLog,'utf8')).split('\n').filter(Boolean).map(s=>JSON.parse(s));const opens=hostRows.filter(r=>r.kind==='open');assert.ok(opens.length);assert.ok(opens.every(r=>r.settings.run.system_prompt==='HOOK_SYSTEM_REPLACED_14'));assert.ok(opens.every(r=>!r.settings.run.toolset.includes('mcp__pi__hook_removed')),'removed tool still exposed to official client');const inputs=hostRows.filter(r=>r.kind==='input');assert.ok(inputs.length);assert.ok(inputs.every(r=>r.text.includes('HOOK_REPLACED_14')&&!r.text.includes('ORIGINAL_SHOULD_NOT_REACH_HOST')),'replacement did not reach official SDK fixture');}
 assert.ok(messages.every(m=>!m.content.some(c=>c.type==='text'&&c.text.includes('ORIGINAL_SHOULD_NOT_REACH_HOST'))));
 console.log(JSON.stringify({mode:live?'live':'offline',path:name,exit:code,callbacks:rows.length,result:'PASS',home}));
}
