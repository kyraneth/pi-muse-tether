import {afterEach,expect,it,vi} from 'vitest';
import {isContextOverflow} from '@earendil-works/pi-ai';
import {createMuseProvider} from '../src/provider.js';
import {MUSE_INBOUND_FRAME_LIMIT_BYTES} from '../src/host.js';
import {openFixtureHost,fixtureState} from './fixture-host.js';
const tools=[{name:'lookup',description:'offline',parameters:{type:'object',properties:{},additionalProperties:false}}];
const model={id:'echo',provider:'pi-muse-tether'};
const providers:any[]=[];
const opened:any[]=[];
const host=async(onEvent?:any)=>{const h=await openFixtureHost({cwd:process.cwd(),tools:['lookup'],promptMode:'none',echo:true,onEvent});opened.push(h);return h;};
afterEach(async()=>{for(const p of providers)await p.retireAll();providers.length=0;for(const h of opened.splice(0))await h.close().catch(()=>{});fixtureState.opens=[];fixtureState.events=[];fixtureState.inputTooLarge=undefined;vi.unstubAllEnvs();});
// 10,600,000 plain characters is over the client's 10 MiB inbound frame once
// the JSON envelope and the rest of the turn are counted.
const HUGE='x'.repeat(10_600_000);
it('refuses an oversized turn frame locally with both numbers and leaves the host usable',async()=>{
 const h=await host();
 const error=await h.submitInput(HUGE).catch((e:any)=>e);
 expect(error.code).toBe('MUSE_FRAME_TOO_LARGE');expect(error.limitBytes).toBe(MUSE_INBOUND_FRAME_LIMIT_BYTES);
 expect(error.frameBytes).toBeGreaterThan(MUSE_INBOUND_FRAME_LIMIT_BYTES);
 expect(error.message).toMatch(/\d+ bytes; the client limit is 10485760 bytes/);
 expect(error.message).toMatch(/indivisible input/);
 // Nothing was written to the client, and the refusal is not a session fence.
 expect(fixtureState.events.filter((e:any)=>e.kind==='input')).toHaveLength(0);
 expect(h.fencedReason).toBeUndefined();
 const ack=await h.submitInput('small request');
 expect(ack.turnId).toBeTruthy();
 expect(fixtureState.events.filter((e:any)=>e.kind==='input').map((e:any)=>e.text)).toEqual(['small request']);
});
it("reports the client's own inputTooLarge refusal with its limit instead of a no-replay fence",async()=>{
 const h=await host();fixtureState.inputTooLarge=true;
 const error=await h.submitInput('small request').catch((e:any)=>e);
 expect(error.code).toBe('MUSE_FRAME_TOO_LARGE');expect(error.limitBytes).toBe(10485760);
 expect(error.message).toMatch(/limit is 10485760 bytes/);expect(error.message).not.toMatch(/no replay/);
 expect(h.fencedReason).toBeUndefined();
 await expect(h.submitInput('after refusal')).resolves.toMatchObject({turnId:expect.any(String)});
});
it('accepts the exactly measured SDK line and rejects the next byte before writing',async()=>{
 vi.stubEnv('FIXTURE_HOST_STAGE_LOG','1');
 let finish!:()=>void;const terminal=new Promise<void>(resolve=>finish=resolve);
 const h=await host((event:any)=>{if(event.kind==='terminal')finish();}), prefix='quote: " backslash: \\ line: \n nul: \0 non-BMP: 🍋\n';
 const input=prefix+'x'.repeat(MUSE_INBOUND_FRAME_LIMIT_BYTES-h.measureTurn()(prefix));
 await h.submitInput(input);await terminal;
 const written=fixtureState.events.find(e=>e.kind==='input');
 expect(written.bytes).toBe(MUSE_INBOUND_FRAME_LIMIT_BYTES);
 expect(written.requestId).toMatch(/^[0-9a-f-]{36}$/);
 await expect(h.submitInput(input+'x')).rejects.toMatchObject({code:'MUSE_FRAME_TOO_LARGE',frameBytes:MUSE_INBOUND_FRAME_LIMIT_BYTES+1});
 expect(fixtureState.events.filter(e=>e.kind==='input')).toHaveLength(1);
});
it('refuses oversized indivisible provider input without asking Pi to compact',async()=>{
 const provider=createMuseProvider({openHost:async(options:any)=>openFixtureHost(options)});providers.push(provider);
 provider.setSessionManager({getSessionId:()=>'frame-limit-seed',getSessionFile:()=>'offline.jsonl',getBranch:()=>[],buildSessionProjection:()=>({messages:[]})} as any);
 const result=await provider.streamViaMuse(model,{messages:[{role:'user',content:HUGE}],tools},{}).result();
 expect(result.stopReason).toBe('error');
 expect(result.errorMessage).toMatch(/\d+ bytes; the client limit is 10485760 bytes/);
 expect(isContextOverflow(result)).toBe(false);
 expect(fixtureState.events.filter((e:any)=>e.kind==='input')).toHaveLength(0);
});
