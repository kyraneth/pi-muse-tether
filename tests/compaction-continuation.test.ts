import {afterEach,expect,it} from 'vitest';
import {convertToLlm} from '@earendil-works/pi-coding-agent';
import {createMuseProvider} from '../src/provider.js';
import {openFixtureHost,fixtureState} from './fixture-host.js';
const tools=[{name:'lookup',description:'offline',parameters:{type:'object',properties:{},additionalProperties:false}}];
const model={id:'echo',provider:'pi-muse-tether'};
const messages=()=>[{role:'compactionSummary',summary:'COMMITTED_TASK',tokensBefore:545967,timestamp:1},{role:'assistant',content:[{type:'toolCall',id:'a',name:'lookup',arguments:{}},{type:'toolCall',id:'b',name:'lookup',arguments:{}}],timestamp:2},...['a','b'].map(toolCallId=>({role:'toolResult',toolCallId,toolName:'lookup',content:[{type:'text',text:'complete-'+toolCallId}],timestamp:3}))];
const providers:any[]=[];
function factory(death=false){
 const state:any={messages:messages(),branch:[{id:'commit-1',type:'compaction'}],death};
 const p=createMuseProvider({openHost:async(options:any)=>state.death?({retrySafe:false,submitInput:async()=>options.onEvent({kind:'fenced',reason:'Host died'}),fence(){},close:async()=>{}} as any):openFixtureHost(options)});providers.push(p);
 p.setSessionManager({getSessionId:()=> 'compaction-seed',getSessionFile:()=> 'offline.jsonl',getBranch:()=>state.branch,buildSessionProjection:()=>({messages:state.messages})});
 state.p=p;state.run=(ms=convertToLlm(state.messages as any))=>p.streamViaMuse(model,{messages:ms,tools},{}).result();
 state.commit=(reason='threshold')=>p.committedCompaction({reason,willRetry:reason==='overflow',compactionEntry:state.branch.at(-1)});
 return state;
}
afterEach(async()=>{for(const p of providers)await p.retireAll();providers.length=0;fixtureState.opens=[];fixtureState.events=[];});
it('a committed exact projection imports the complete batch as inert history and consumes its one-shot grant',async()=>{
 const s=factory();await s.commit();expect((await s.run()).stopReason).toBe('stop');
 const input=fixtureState.events.find((x:any)=>x.kind==='input').text;expect(input).toContain('PI COMMITTED COMPACTION CONTINUATION');expect(input).toContain('complete-b');
 await s.p.retireAll();expect((await s.run()).errorMessage).toContain('new Pi user request');expect(fixtureState.opens).toHaveLength(1);
});
it.each(['unrelated','changed-context','changed-boundary','manual','incomplete'])('refuses %s trailing results before opening any host',async(seed)=>{
 const s=factory();
 if(seed!=='unrelated')await s.commit(seed==='manual'?'manual':'threshold');
 if(seed==='changed-context')s.messages.at(-1).content[0].text='not the committed projection';
 if(seed==='changed-boundary')s.branch.push({id:'later',type:'message'});
 if(seed==='incomplete'){s.messages.splice(-2,1);await s.commit();}
 const result=await s.run();expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain(seed==='incomplete'?'incomplete tool calls':'new Pi user request');expect(fixtureState.opens).toHaveLength(0);
});
it.each([false,true])('a lone tool result cannot bypass the importer fast path (committed=%s)',async(committed)=>{
 const s=factory();s.messages=[s.messages.at(-1)];if(committed)await s.commit();
 expect((await s.run()).errorMessage).toContain(committed?'unmatched tool result':'new Pi user request');expect(fixtureState.opens).toHaveLength(0);
});
it('host death with trailing results still refuses, even if someone later commits a threshold compaction',async()=>{
 const s=factory(true);expect((await s.run([{role:'user',content:'live request'}])).errorMessage).toContain('Host died');
 const refused=await s.run();expect(refused.errorMessage).toContain('no automatic resubmit');
 await s.commit();expect((await s.run()).errorMessage).toContain('no automatic resubmit');
});
it('a genuinely new user request clears the old death fence for its own later compaction',async()=>{
 const s=factory(true);await s.run([{role:'user',content:'failed old request'}]);s.death=false;
 expect((await s.run([{role:'user',content:'genuinely new request'}])).stopReason).toBe('stop');
 await s.p.retireAll();await s.commit();expect((await s.run()).stopReason).toBe('stop');
});
it('Pi timing/thinking metadata does not invalidate the committed semantic history',async()=>{
 const s=factory();await s.commit();const ms=convertToLlm(s.messages as any) as any[];ms[1].thinkingLevel='high';ms[1].durationMs=34;
 expect((await s.run(ms)).stopReason).toBe('stop');
});
