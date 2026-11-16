import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MuseLedger, flushMuseLedger, museLedgerPath } from '../src/request-ledger.js';
// @ts-ignore Native reusable guard helpers.
import { snapshot, productionTargets } from '../scripts/test-guard.mjs';
const preload = resolve('scripts/test-isolation.mjs');

it('global setup isolates state and qualification records and stamps every ledger row', async () => {
  for (const name of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'PI_MUSE_TETHER_QUALIFICATION_HOME']) {
    expect(process.env[name]).toContain('pi-muse-tether-isolation-');
  }
  expect(process.env.MUSE_NO_AUTO_UPDATE).toBe('1');
  const ledger = new MuseLedger('isolation-fixture', 'echo');
  ledger.record('isolation_probe', {origin: 'live', packageVersion: 'forged'});
  await flushMuseLedger();
  const rows = readFileSync(museLedgerPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  for (const row of rows.filter(row => row.piSessionId === 'isolation-fixture'))
    expect(row).toMatchObject({ origin: 'test', packageVersion: version, piSessionId: 'isolation-fixture' });
});

it('native preload overrides unsafe inherited paths, restores environment and removes temp home', () => {
  // This subprocess deliberately imports setup after taking its baseline.
  const env = { ...process.env, NODE_OPTIONS: '', XDG_STATE_HOME: join(homedir(), '.local/state'), PI_MUSE_TETHER_QUALIFICATION_HOME: '/unsafe/inherited', PI_MUSE_TETHER_LEDGER_ORIGIN: 'proof', PI_MUSE_TETHER_LIVE: '1' };
  const script = `
    import {existsSync} from 'node:fs';
    const before = {...process.env};
    const {installTestIsolation} = await import(${JSON.stringify(preload)});
    const isolation = installTestIsolation();
    const root = isolation.root;
    if (process.env.XDG_STATE_HOME === before.XDG_STATE_HOME || process.env.PI_MUSE_TETHER_QUALIFICATION_HOME === before.PI_MUSE_TETHER_QUALIFICATION_HOME) throw Error('not isolated');
    if (process.env.PI_MUSE_TETHER_LIVE !== '1') throw Error('proof opt-in lost');
    isolation.dispose();
    if (existsSync(root) || JSON.stringify(process.env) !== JSON.stringify(before)) throw Error('cleanup/restore failed');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});

it.each(['test', 'proof', 'live'])('native ledger provenance is %s and default runner path is refused', origin => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {MuseLedger,flushMuseLedger,museLedgerPath} from './src/request-ledger.ts';
    import {readFileSync} from 'node:fs';
    import {homedir} from 'node:os';
    import {join} from 'node:path';
    new MuseLedger('native-isolation-fixture','echo'); await flushMuseLedger();
    const row=JSON.parse(readFileSync(museLedgerPath(),'utf8').trim().split('\\n').at(-1));
    if(row.origin!==${JSON.stringify(origin)})throw Error(JSON.stringify(row));
    process.env.NODE_TEST_CONTEXT='child-v8';
    process.env.XDG_STATE_HOME=join(homedir(),'.local/state');
    let refused=false;try{museLedgerPath();}catch{refused=true;}
    if(!refused)throw Error('default runner ledger accepted');
  `], { env: { ...process.env, NODE_OPTIONS: '', VITEST: '', NODE_TEST_CONTEXT: '', PI_MUSE_TETHER_LEDGER_ORIGIN: origin }, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});

it('guard re-enumerates native client builds and retains before/after hashes', () => {
  const home = mkdtempSync(join(tmpdir(), 'muse-guard-home-'));
  try {
    const bin = join(home, '.local/bin'); mkdirSync(bin, {recursive:true});
    writeFileSync(join(bin, 'muse'), 'original launcher');
    writeFileSync(join(bin, 'muse-bin-old'), 'old build');
    const qualifications=join(home,'.local/share/pi-muse-tether/qualifications');
    mkdirSync(qualifications,{recursive:true});writeFileSync(join(qualifications,'record.json'),'before');
    expect(productionTargets({}, home)).toContain(join(bin, 'muse-bin-old'));
    expect(productionTargets({}, home)).toContain(qualifications);
    const custom=join(home,'custom-qualifications');
    expect(productionTargets({XDG_DATA_HOME:join(home,'data'),PI_MUSE_TETHER_QUALIFICATION_HOME:custom},home)).toEqual(expect.arrayContaining([qualifications,join(home,'data/pi-muse-tether/qualifications'),custom]));
    const receipt = join(home, 'receipt.json');
    const env = {...process.env, NODE_OPTIONS:'', HOME:home,
      XDG_STATE_HOME:join(home,'state'), XDG_DATA_HOME:join(home,'data'),
      PI_MUSE_TETHER_ISOLATION_RECEIPT:receipt};
    const result = spawnSync(process.execPath, [resolve('scripts/test-guard.mjs'), '--', process.execPath, '--input-type=module', '-e', `
      import {writeFileSync,unlinkSync} from 'node:fs';
      writeFileSync(${JSON.stringify(join(bin,'muse'))}, 'changed launcher');
      unlinkSync(${JSON.stringify(join(bin,'muse-bin-old'))});
      writeFileSync(${JSON.stringify(join(bin,'muse-bin-new'))}, 'new build');
      writeFileSync(${JSON.stringify(join(home,'.local/share/pi-muse-tether/qualifications/record.json'))}, 'changed');
    `], {env,encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Production state changed');
    const proof = JSON.parse(readFileSync(receipt,'utf8'));
    expect(proof.changed.sort()).toEqual([...['muse','muse-bin-new','muse-bin-old'].map(name=>join(bin,name)),qualifications].sort());
    expect(proof.before[join(bin,'muse')].sha256).toBe(createHash('sha256').update('original launcher').digest('hex'));
    expect(proof.after[join(bin,'muse')].sha256).toBe(createHash('sha256').update('changed launcher').digest('hex'));
    expect(proof.before[join(bin,'muse-bin-new')]).toEqual({kind:'absent'});
    expect(proof.after[join(bin,'muse-bin-old')]).toEqual({kind:'absent'});
  } finally {rmSync(home,{recursive:true,force:true});}
});

it('recursive snapshots detect changed bytes, additions and removed targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-snapshot-fixture-'));
  try {
    mkdirSync(join(dir, 'build')); writeFileSync(join(dir, 'build', 'binary'), 'before');
    const before = snapshot(dir);
    const multiChunk = Buffer.alloc(64 * 1024 + 123, 'x');
    writeFileSync(join(dir, 'build', 'binary'), multiChunk);
    expect(snapshot(join(dir, 'build', 'binary')).sha256).toBe(createHash('sha256').update(multiChunk).digest('hex'));
    writeFileSync(join(dir, 'build', 'binary'), 'after!');
    expect(snapshot(dir)).not.toEqual(before);
    writeFileSync(join(dir, 'build', 'binary'), 'before');
    expect(snapshot(dir)).toEqual(before);
    writeFileSync(join(dir, 'qualification.json'), '{}'); expect(snapshot(dir)).not.toEqual(before);
    rmSync(dir, {recursive:true}); expect(snapshot(dir)).toEqual({kind:'absent'});
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
