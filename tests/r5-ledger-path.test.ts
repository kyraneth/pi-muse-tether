import {it,expect,vi,afterEach} from 'vitest';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {museLedgerPath} from '../src/request-ledger.js';
afterEach(()=>vi.unstubAllEnvs());
it.each([undefined,'','relative/state'])('uses the absolute home default with XDG_STATE_HOME=%j',value=>{
 vi.stubEnv('XDG_STATE_HOME',value);
 expect(museLedgerPath()).toBe(join(homedir(),'.local/state/pi-muse-tether/requests.jsonl'));
 expect(isAbsolute(museLedgerPath())).toBe(true);
});
it('honours an explicit nonempty state root',()=>{
 vi.stubEnv('XDG_STATE_HOME','/explicit/state');
 expect(museLedgerPath()).toBe('/explicit/state/pi-muse-tether/requests.jsonl');
});
