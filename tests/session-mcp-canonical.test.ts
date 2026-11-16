import {it,expect,vi} from 'vitest';
import {mkdtemp,realpath,symlink,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const observed=vi.hoisted(()=>({starts:[] as any[],capabilities:[] as any[],inventory:[] as any[],stopAtInitialize:false,privateUnavailable:false,settings:[] as any[]}));
vi.mock('@muse-code/sdk',async(importOriginal)=>{
 const sdk=await importOriginal<any>();
 return {...sdk,spawnMspConnection:(launch:any)=>{
  const h=sdk.spawnMspConnection(launch);const initialize=h.initialize.bind(h);
  h.initialize=async(params:any)=>{
   observed.capabilities.push(params.capabilities);
   if(observed.stopAtInitialize)throw new Error('initialize wiring observed');
   const s=await initialize(params);
   observed.settings.push(JSON.parse(await readFile(join(launch.env.XDG_CONFIG_HOME,'muse/settings.json'),'utf8').catch(()=>'{"run":{}}')));
   if(observed.privateUnavailable)s.initializeResult={...s.initializeResult,experimentalApi:false};
   const command=s.connection.command.bind(s.connection);
   const request=s.connection.request.bind(s.connection);
   s.connection.request=async(method:string,p:any,...rest:any[])=>{
    const result=await request(method,p,...rest);
    if(method==='mcpServer/readInventory')observed.inventory.push(result);
    return result;
   };
   s.connection.command=async(method:string,p:any,...rest:any[])=>{
    if(method==='session/start')observed.starts.push({params:p,trust:JSON.parse(await readFile(join(launch.env.XDG_CONFIG_HOME,'muse/trust.json'),'utf8'))});
    return command(method,p,...rest);
   };return s;
  };return h;
 }};
});
import {openMuseHost} from '../src/host.ts';
it('MCP alone requests experimentalApi without private prompt or batches',async()=>{
 observed.stopAtInitialize=true;
 try {
  await expect(openMuseHost({cwd:process.cwd(),tools:['read'],promptMode:'none',echo:true,
   binary:process.env.PI_MUSE_TETHER_BINARY,mcpServers:{pi:{transport:'stdio',command:'/nonexistent',args:[]}}})).rejects.toThrow('initialize wiring observed');
  expect(observed.capabilities.at(-1).experimentalApi).toBe(true);
 }finally{observed.stopAtInitialize=false;}
});
it('open path canonicalizes symlinked TMPDIR for trust and actual session/start (real offline echo)',async()=>{
 const binary=process.env.PI_MUSE_TETHER_BINARY!;
 const base=await realpath(await mkdtemp(join(tmpdir(),'muse-canonical-')));
 const old=process.env.TMPDIR;
 await mkdir(join(base,'actual'));await symlink(join(base,'actual'),join(base,'alias'));
 process.env.TMPDIR=join(base,'alias');
 try {
  const host=await openMuseHost({cwd:base,tools:['fixture_read'],promptMode:'replace',privatePrompt:{systemPrompt:'',skillsOff:{}},echo:true,binary,
   mcpServers:{pi:{transport:'stdio',command:process.execPath,args:[resolve('tests/fixtures/readiness-mcp.mjs')],framing:'lineDelimitedJson',mode:'required'}}});
  try {
   const {params,trust}=observed.starts.at(-1);
   expect(params.workspaceRoot).toBe(await realpath(params.workspaceRoot));
   expect(params.workspaceRoot.startsWith(join(base,'actual'))).toBe(true);
   expect(trust.projects).toEqual({[params.workspaceRoot]:{decision:'trusted'}});
   expect(observed.capabilities.at(-1).experimentalApi).toBe(true);
   if(observed.inventory.length)expect(observed.inventory.at(-1).servers.find((s:any)=>s.name==='pi')).toMatchObject({state:'connected',tools:['fixture_read']});
   console.log('canonical offline proof',JSON.stringify({workspaceRoot:params.workspaceRoot,trust,inventory:observed.inventory}));
  }finally{await host.close();}
 }finally{if(old===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=old;await rm(base,{recursive:true,force:true});}
});
it('private replacement unavailable reopens before any turn with supported appended developer instructions and one notice',async()=>{
 observed.privateUnavailable=true;observed.settings=[];
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try {
  const host=await openMuseHost({cwd:process.cwd(),tools:['read'],promptMode:'replace',privatePrompt:{systemPrompt:'EXACT_PI_PROMPT',skillsOff:{}},echo:true,binary:process.env.PI_MUSE_TETHER_BINARY});
  try {
   expect(observed.settings).toHaveLength(2);
   expect(observed.settings[0].run.system_prompt).toBe('EXACT_PI_PROMPT');
   expect(observed.settings[1].run.system_prompt).toBeUndefined();
   expect(observed.settings[1].run.developer_prompt).toBe('EXACT_PI_PROMPT');
   expect(warn.mock.calls.filter(([line])=>String(line).includes('"feature":"privatePrompt"'))).toHaveLength(1);
  }finally{await host.close();}
 }finally{observed.privateUnavailable=false;warn.mockRestore();}
});
