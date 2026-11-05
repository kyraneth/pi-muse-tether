// Offline native Pi fixture: shipped registration + provider + real SDK host.
import {registerMuseExtension} from '../index.ts';
import {createMuseProvider} from '../src/provider.js';
import {fixtureState,openFixtureHost} from './fixture-host.js';
export default async function(pi:any) {
 fixtureState.quotaMode=process.env.R5_QUOTA_PHASE;
 const provider=createMuseProvider({openHost:async options=>{
  const original=options.onEvent;
  return openFixtureHost({...options,onEvent:event=>{
   // Seed the former fence wording at its actual provider ingress boundary.
   // No vendor endpoint, refusal, timer or replay is induced by this fixture.
   if(process.env.R5_QUOTA_RETRY_WORDING==='1' && event.kind==='fenced' && event.reason.includes('quota refused'))
    original?.({...event,reason:'Muse rate limit; no replay'});
   else original?.(event);
  }});
 },toolBatches:false,promptModes:['none','replace'],promptMode:'replace',instructionMechanisms:['private-settings-fixture'],rawCompletion:true} as any);
 return registerMuseExtension(pi,provider);
}
