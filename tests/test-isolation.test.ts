import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir, userInfo } from 'node:os';
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

it('refuses symlinked, HOME-overridden and PI_MUSE_TETHER_LEDGER_PATH production ledger paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'muse-ledger-symlink-'));
  const realHome = userInfo().homedir;
  const realState = join(realHome, '.local/state');
  const fakeHome = join(dir, 'fake-home');
  const fakeState = join(fakeHome, '.local/state');
  mkdirSync(fakeState, { recursive: true });
  const linkToFakeState = join(dir, 'state-link');
  symlinkSync(fakeState, linkToFakeState);
  const isolatedFile = join(dir, 'isolated-ledger/requests.jsonl');
  try {
    // 1. Symlink pointing to HOME/.local/state must be refused.
    const r1 = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { museLedgerPath } from './src/request-ledger.ts';
      museLedgerPath();
    `], { env: { ...process.env, NODE_OPTIONS: '', VITEST: '1', HOME: fakeHome, XDG_STATE_HOME: linkToFakeState, PI_MUSE_TETHER_LEDGER_PATH: '' }, encoding: 'utf8' });
    expect(r1.status).not.toBe(0);
    expect(r1.stderr).toContain('refusing the production ledger');

    // 2. Real userInfo().homedir/.local/state must still be refused even when HOME is overridden.
    const r2 = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { museLedgerPath } from './src/request-ledger.ts';
      museLedgerPath();
    `], { env: { ...process.env, NODE_OPTIONS: '', VITEST: '1', HOME: fakeHome, XDG_STATE_HOME: realState, PI_MUSE_TETHER_LEDGER_PATH: '' }, encoding: 'utf8' });
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toContain('refusing the production ledger');

    // 3. Explicit PI_MUSE_TETHER_LEDGER_PATH works when isolated, refuses when targeting production.
    const r3 = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { museLedgerPath } from './src/request-ledger.ts';
      const p = museLedgerPath();
      if (p !== ${JSON.stringify(isolatedFile)}) throw Error('unexpected path: ' + p);
    `], { env: { ...process.env, NODE_OPTIONS: '', VITEST: '1', HOME: fakeHome, XDG_STATE_HOME: fakeState, PI_MUSE_TETHER_LEDGER_PATH: isolatedFile }, encoding: 'utf8' });
    expect(r3.status, r3.stderr).toBe(0);

    const r4 = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { museLedgerPath } from './src/request-ledger.ts';
      museLedgerPath();
    `], { env: { ...process.env, NODE_OPTIONS: '', VITEST: '1', HOME: fakeHome, XDG_STATE_HOME: dir, PI_MUSE_TETHER_LEDGER_PATH: join(linkToFakeState, 'pi-muse-tether/requests.jsonl') }, encoding: 'utf8' });
    expect(r4.status).not.toBe(0);
    expect(r4.stderr).toContain('refusing the production ledger');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('test-isolation refuses a PI_MUSE_TETHER_PROOF_HOME that resolves to the production ledger', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'muse-proof-bypass-'));
  const localDir = join(fakeHome, '.local');
  const prodState = join(localDir, 'state');
  mkdirSync(prodState, { recursive: true });
  try {
    const env = {
      ...process.env,
      NODE_OPTIONS: '',
      HOME: fakeHome,
      MUSE_NO_AUTO_UPDATE: '1',
      PI_MUSE_TETHER_PROOF_HOME: localDir,
      XDG_STATE_HOME: prodState,
      XDG_DATA_HOME: join(localDir, 'share'),
      PI_MUSE_TETHER_QUALIFICATION_HOME: join(localDir, 'qual'),
    };
    const script = `
      const { installTestIsolation } = await import(${JSON.stringify(preload)});
      const isolation = installTestIsolation();
      if (process.env.XDG_STATE_HOME === ${JSON.stringify(prodState)}) throw Error('proof bypass accepted production state');
      isolation.dispose();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(fakeHome, { recursive: true, force: true }); }
});

it('test-guard fails when a test run writes to the production request ledger and passes when isolated', () => {
  const home = mkdtempSync(join(tmpdir(), 'muse-guard-ledger-'));
  try {
    const prodDir = join(home, '.local/state/pi-muse-tether');
    const prodLedger = join(prodDir, 'requests.jsonl');
    mkdirSync(prodDir, { recursive: true });
    const original = JSON.stringify({ type: 'request', origin: 'live' }) + '\n';
    writeFileSync(prodLedger, original);
    const originalHash = createHash('sha256').update(original).digest('hex');

    // productionTargets must always cover the real OS user ledger even when HOME is overridden.
    expect(productionTargets({}, home)).toContain(join(userInfo().homedir, '.local/state/pi-muse-tether/requests.jsonl'));

    // 1. Writing through MuseLedger under test-guard leaves the production ledger byte-identical.
    const passReceipt = join(home, 'pass-receipt.json');
    const baseEnv = { ...process.env, NODE_OPTIONS: '', HOME: home, XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share'), PI_MUSE_TETHER_ISOLATION_RECEIPT: passReceipt };
    const clean = spawnSync(process.execPath, [resolve('scripts/test-guard.mjs'), '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', `
      import { MuseLedger, flushMuseLedger } from './src/request-ledger.ts';
      new MuseLedger('isolated-guard-check', 'echo');
      await flushMuseLedger();
    `], { env: baseEnv, encoding: 'utf8' });
    expect(clean.status, clean.stderr).toBe(0);
    expect(createHash('sha256').update(readFileSync(prodLedger)).digest('hex')).toBe(originalHash);
    expect(JSON.parse(readFileSync(passReceipt, 'utf8')).changed).toEqual([]);

    // 2. If a test mutates the production request ledger directly, test-guard MUST fail and name it.
    const failReceipt = join(home, 'fail-receipt.json');
    const polluted = spawnSync(process.execPath, [resolve('scripts/test-guard.mjs'), '--', process.execPath, '--input-type=module', '-e', `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(prodLedger)}, JSON.stringify({ type: 'fixture', origin: 'test' }) + '\\n');
    `], { env: { ...baseEnv, PI_MUSE_TETHER_ISOLATION_RECEIPT: failReceipt }, encoding: 'utf8' });
    expect(polluted.status).toBe(1);
    expect(polluted.stderr).toContain('Production state changed');
    expect(polluted.stderr).toContain('requests.jsonl');
    const proof = JSON.parse(readFileSync(failReceipt, 'utf8'));
    expect(proof.changed).toContain(prodLedger);
    expect(proof.before[prodLedger].sha256).toBe(originalHash);
    expect(proof.after[prodLedger].sha256).not.toBe(originalHash);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
