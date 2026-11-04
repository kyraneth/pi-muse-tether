import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnMspConnection} from '@muse-code/sdk';
import {museLaunchOptions,type MuseHostOptions} from '../src/host.ts';
import {writePromptSettings} from '../src/settings.ts';

// Runs the pinned official binary, NEVER a live provider. No real config/login.
// Echo rejects nonempty base instructions at session construction. This probe
// uses an empty prompt; actual Pi prompt + live execution remain root-only.
it('official echo: exact Pi-only named toolsets, no false read-only policy; flags reproduce defect',async()=>{
 const root=await mkdtemp(join(tmpdir(),'muse-capability-policy-'));
 const binary=process.env.PI_MUSE_TETHER_BINARY??join(homedir(),'.local/bin/muse');
 const mcp=join(dirname(fileURLToPath(import.meta.url)),'fixtures/capability-policy-mcp.py');
 const rows=[
  {name:'legacy',tools:['bash','edit','write'],private:false},
  {name:'private',tools:['write','read'],private:true},
  {name:'raw',tools:[],private:true},
  {name:'missing-tool',tools:['not_available'],private:true,missing:true},
  {name:'defect-control',tools:['bash','edit','write'],private:true,defect:true},
 ];
 try {for(const row of rows){
  const home=join(root,row.name),cwd=join(home,'workspace');await mkdir(cwd,{recursive:true});
  await writePromptSettings(home,'',row.tools,{});
  const options:MuseHostOptions={cwd,binary,echo:true,tools:row.tools,promptMode:row.private?'replace':'none',
   ...(row.private?{privatePrompt:{systemPrompt:'SYNTHETIC_OFFLINE_PROMPT',skillsOff:{}}}:{}),
   ...(row.name==='raw'?{purpose:'raw'}:{})};
  const launch=museLaunchOptions(options);
  if(row.defect)launch.args!.push('--disable-shell','--disable-write');
  const handshake=spawnMspConnection({...launch,env:{...launch.env,HOME:home,XDG_CONFIG_HOME:join(home,'config'),
   XDG_DATA_HOME:join(home,'data'),XDG_CACHE_HOME:join(home,'cache'),XDG_STATE_HOME:join(home,'state')}});
  try {
   const spawned=await handshake.initialize({clientInfo:{name:'pi_capability_policy_test',version:'1'},
    capabilities:{experimentalApi:true,requestedCapabilities:['sessionMcp','rawLog'],userInputDialogs:false}});
   const c=spawned.connection;
   let terminal!:(value:any)=>void;const completed=new Promise<any>(r=>terminal=r);
   c.onNotification(f=>{if(f.method==='turn/completed')terminal(f.params);});
   const opened=await c.command('session/start',{workspaceRoot:cwd,approvalMode:'promptUnmatched',config:{mcpServers:
    row.tools.length?{pi:{transport:'stdio',command:'python3',args:[mcp,...(row.missing?[]:row.tools)],mode:'required'}}:{}}},{maxAttempts:1});
   const sessionId=opened.session.sessionId;
   await c.command('turn/start',{sessionId,input:[{type:'text',text:'Synthetic offline echo only.'}]},{maxAttempts:1});
   const end=await completed;
   const streams=await c.command('log/streams',{sessionId},{maxAttempts:1});
   const records:any[]=[];
   for(const entry of streams.streams){
    let from:any;
    while(true){
     // 1000 is the official exported LogPageParams maximum, not a workload cap.
     const page=await c.command('log/page',{sessionId,stream:entry.stream,limit:1000,...(from?{from}:{})},{maxAttempts:1});
     records.push(...page.records);if(!page.records.length)break;from=page.nextCursor!.after;
    }
   }
   const events=records.map(r=>r.payload?.event).filter(e=>e?.kind==='model_request_configured');
   if(row.missing){
    expect(end.terminal).toBe('failed');expect(events).toEqual([]);
    expect(JSON.stringify(records)).toContain('not_available');
    console.log(JSON.stringify({row:row.name,terminal:end.terminal,officialConfiguredEvents:events.length,noDefaultFallback:true}));
    continue;
   }
   expect(events.length,row.name+' official request boundary').toBeGreaterThan(0);
   for(const event of events){
    expect([...event.toolset.active_tools].sort(),row.name).toEqual(row.tools.map(n=>'mcp__pi__'+n).sort());
    const policy=event.run_context_messages.filter((m:any)=>m.source==='capability_policy'||m.id==='capability_policy');
    if(row.defect){
     expect(policy).toHaveLength(1);expect(policy[0]).toMatchObject({role:'developer',lifecycle:'session_start',order:90});
     expect(policy[0].text).toContain('Filesystem writes are disabled for this session.');
     expect(policy[0].text).toContain('Shell execution is disabled for this session.');
    }else{
     expect(policy,row.name).toEqual([]);
     expect(JSON.stringify(event.run_context_messages)).not.toMatch(/Filesystem writes are disabled for this session|Shell execution is disabled for this session/);
    }
   }
   console.log(JSON.stringify({row:row.name,activeTools:events[0].toolset.active_tools,capabilityPolicy:!!row.defect,officialBoundary:'model_request_configured'}));
  }finally{await handshake.close();}
 }}finally{await rm(root,{recursive:true,force:true});}
},0); // Disable Vitest's default wall-clock limit for official process startup.

it('invalid/wildcard Pi names fail pre-spawn, never a native/default toolset fallback',()=>{
 for(const tools of [['*'],['bash*'],[''],['write','write']])expect(()=>museLaunchOptions({cwd:process.cwd(),tools,promptMode:'none',echo:true})).toThrow('distinct exact names');
});
