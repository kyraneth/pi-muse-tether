import {it,expect,afterEach} from 'vitest';
import {openFixtureHost,fixtureState} from './fixture-host.ts';
const options=()=>({cwd:process.cwd(),tools:['read'],promptMode:'none' as const,
 mcpServers:{pi:{transport:'stdio',command:'/nonexistent',args:[] as string[]}}});
const row=(name:string,state:string)=>({name,state,tools:['read']});
afterEach(()=>{for(const k of ['inventory','inventoryReads','inventoryError','onInventory','sessionStart'])delete fixtureState[k];});
it.each([[-32601,'experimentalRequired'],[-32000,'internalError']])('inventory error %s %s propagates',async(code,kind)=>{
 fixtureState.inventoryError={code,message:`inventory refused: ${kind}`,data:{kind,retryable:false}};
 await expect(openFixtureHost(options() as any)).rejects.toThrow(`inventory refused: ${kind}`);
 expect(fixtureState.inventoryReads).toBe(1);
});
it('absent registration then connected succeeds',async()=>{
 fixtureState.inventory=[[],[row('pi','connected')]];
 const h=await openFixtureHost(options() as any);expect(fixtureState.inventoryReads).toBe(2);await h.close();
});
it('waits for every configured server',async()=>{
 fixtureState.inventory=[[row('pi','connected')],[row('pi','connected'),row('second','starting')],[row('pi','connected'),row('second','connected')]];
 const o=options();const h=await openFixtureHost({...o,mcpServers:{...o.mcpServers,second:o.mcpServers.pi}} as any);
 expect(fixtureState.inventoryReads).toBe(3);await h.close();
});
it('abort during readiness rejects without another inventory read',async()=>{
 const controller=new AbortController();fixtureState.inventory=[[row('pi','starting')]];
 fixtureState.onInventory=()=>queueMicrotask(()=>controller.abort());
 await expect(openFixtureHost({...options(),signal:controller.signal} as any)).rejects.toThrow(/abort/i);
 expect(fixtureState.inventoryReads).toBe(1);
});
it('private workspace is wired into session/start',async()=>{
 const workspace='/fixture/private/workspace';
 const h=await openFixtureHost({...options(),promptMode:'replace',privatePrompt:{systemPrompt:'test'},privateWorkspace:workspace} as any);
 expect(fixtureState.sessionStart.workspaceRoot).toBe(workspace);await h.close();
});
