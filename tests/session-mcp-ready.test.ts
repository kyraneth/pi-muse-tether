import {it,expect,afterEach} from 'vitest';
import {openFixtureHost,fixtureState} from './fixture-host.ts';

// Muse 1.4.15 starts session MCP after session/start (measured live: "starting"
// with no tools, "connected" ~200 ms later; untrusted workspaceRoot: "withheld").
const options=()=>({cwd:process.cwd(),tools:['read'],promptMode:'none' as const,
 mcpServers:{pi:{transport:'stdio',command:'/nonexistent',args:[] as string[]}}});
const row=(state:string,tools:string[]=[])=>[{name:'pi',required:true,state,tools}];
afterEach(()=>{for(const key of ['inventory','inventoryReads','inventoryError','onInventory','sessionStart'])delete fixtureState[key];});

it('1.4.14 (no inventory method) opens without waiting',async()=>{
 const host=await openFixtureHost(options() as any);
 expect(fixtureState.inventoryReads).toBe(1);
 await host.close();
});

it('waits from starting until connected with every Pi tool',async()=>{
 fixtureState.inventory=[row('starting'),row('starting'),row('connected',['read'])];
 const host=await openFixtureHost(options() as any);
 expect(fixtureState.inventoryReads).toBe(3);
 await host.close();
});

it.each([
 ['withheld',row('withheld'),/pi unavailable \(withheld\); no model request submitted/],
 ['closed',row('closed'),/pi unavailable \(closed\)/],
 ['failed',row('failed'),/pi unavailable \(failed\)/],
 ['error',row('error'),/pi unavailable \(error\)/],
 ['forfeited',row('forfeited'),/pi unavailable \(forfeited\)/],
 ['unknown',row('future-state'),/pi unavailable \(future-state\)/],
 ['malformed',{},/Muse session MCP inventory malformed/],
 ['connected without the Pi tool',row('connected',['other']),/without Pi tools read/],
])('%s fails closed before any turn',async(_name,servers,message)=>{
 fixtureState.inventory=[servers];
 await expect(openFixtureHost(options() as any)).rejects.toThrow(message);
});

it('private prompt names an empty tether-owned workspace and trusts only it',async()=>{
 const {mkdtemp,readFile,readdir,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {writePromptSettings,privateWorkspace}=await import('../src/settings.ts');
 const root=await mkdtemp(join(tmpdir(),'muse-private-ws-'));
 try {
  await writePromptSettings(root,'PROMPT',['read']);
  expect(await readdir(privateWorkspace(root))).toEqual([]);
  const trust=JSON.parse(await readFile(join(root,'config/muse/trust.json'),'utf8'));
  expect(trust).toEqual({schema_version:1,projects:{[privateWorkspace(root)]:{decision:'trusted'}}});
 } finally { await rm(root,{recursive:true,force:true}); }
});
