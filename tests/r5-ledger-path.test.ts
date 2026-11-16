import {it,expect,vi,afterEach} from 'vitest';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {museLedgerPath} from '../src/request-ledger.js';
afterEach(()=>vi.unstubAllEnvs());
it.each([undefined,'','relative/state',join(homedir(),'.local/state')])('refuses production ledger under a runner with XDG_STATE_HOME=%j',value=>{
 vi.stubEnv('XDG_STATE_HOME',value);
 expect(()=>museLedgerPath()).toThrow(/isolated absolute XDG_STATE_HOME/);
});
it('honours the isolated state root supplied by the global setup',()=>{
 expect(museLedgerPath()).toBe(join(process.env.XDG_STATE_HOME!,'pi-muse-tether/requests.jsonl'));
 expect(museLedgerPath()).not.toBe(join(homedir(),'.local/state/pi-muse-tether/requests.jsonl'));
});
