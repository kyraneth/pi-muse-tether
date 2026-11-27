import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const model = 'muse-ember-1.0';
const nonRoot = process.getuid !== undefined && process.getuid() !== 0;

async function run(layout: 'hard-ro' | 'granted' | 'writable', mode: 'list' | 'turn', seedCatalog = false, failure?: 'catalog' | 'skills' | 'replaced-login') {
  const root = await mkdtemp(join(tmpdir(), 'muse-vendor-roots-'));
  const home = join(root, 'home'), temp = join(root, 'tmp'), work = join(root, 'work');
  const config = join(home, 'config'), agent = join(root, 'agent');
  const data = join(home, 'data'), cache = join(home, 'cache'), state = join(home, 'state');
  const auth = join(root, 'synthetic-login.json'), accountLink = join(config, 'muse/auth.json');
  const log = join(root, 'vendor.jsonl'), ledger = join(root, 'ledger.jsonl');
  const qualification = join(root, 'qualification');
  for (const dir of [join(config, 'muse'), agent, temp, work, qualification, data, cache, state]) await mkdir(dir, { recursive: true });
  if (layout === 'granted') for (const dir of [data, cache, state]) await mkdir(join(dir, 'muse'));
  await writeFile(auth, '{}', { mode: 0o444 });
  await utimes(auth, new Date(0), new Date(0)); // A read would advance atime on relatime mounts.
  const metadata = async () => { const s = await stat(auth); return [s.ino, s.size, s.mtimeMs, s.ctimeMs, s.atimeMs]; };
  const before = await metadata();
  await symlink(auth, accountLink);
  await writeFile(join(config, 'muse/settings.json'), '{"fixtureProfile":"unchanged"}');
  for (const dir of [home, config, join(config, 'muse'), ...(layout === 'writable' ? [] : [data, cache, state])]) await chmod(dir, 0o555);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  // Pi's --list-models probes available providers. Never inherit API keys,
  // agent options or other providers' configuration into this offline fixture.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, TMPDIR: temp, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache, XDG_STATE_HOME: state, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
    PI_MUSE_TETHER_PROOF_HOME: root, PI_MUSE_TETHER_QUALIFICATION_HOME: qualification,
    PI_MUSE_TETHER_LEDGER_ORIGIN: 'test', PI_MUSE_TETHER_LEDGER_PATH: ledger, PI_MUSE_TETHER_LIVE: '1',
    PI_MUSE_TETHER_BINARY: resolve('tests/fixtures/vendor-roots.py'), MUSE_NO_AUTO_UPDATE: '1',
    VENDOR_ROOTS_LOG: log, VENDOR_ROOTS_AUTH: auth, VENDOR_ROOTS_SEED_CATALOG: seedCatalog ? '1' : '0', VENDOR_ROOTS_FAILURE: failure ?? '',
  };
  const args = ['-ne', '-ns', '-np', '-nc', '--no-mcp', '-e', resolve('index.ts'), ...(mode === 'list' ? ['--list-models', model] : [
    '--no-session', '--mode', 'json', '-p', '--provider', 'pi-muse-tether', '--model', model, '--thinking', 'minimal', '--no-tools', 'Offline vendor roots test',
  ])];
  const child = spawn(resolve('node_modules/.bin/pi'), args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => stdout += part);
  child.stderr.setEncoding('utf8').on('data', part => stderr += part);
  const code = await new Promise<number | null>((ok, fail) => { child.once('error', fail); child.once('close', ok); });
  const wire: any[] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  // Pi's loader and Node can own their own caches under TMPDIR.
  const scratch = (await readdir(temp)).filter(name => /^pi-muse-(?:host|discovery)-/.test(name));
  const result = { root, args, code, stdout, stderr, scratch, wire, loginBefore: before, loginAfter: await metadata() };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Vendor roots evidence:', join(root, 'result.json'));
  expect(wire.every(event => event.uid === process.getuid!())).toBe(true);
  expect(result.loginAfter).toEqual(before);
  expect(await readlink(accountLink)).toBe(auth);
  expect(await readFile(join(config, 'muse/settings.json'), 'utf8')).toBe('{"fixtureProfile":"unchanged"}');
  return { ...result, auth, home, temp, work, config, data, cache, state, ledger, qualification };
}

async function isolated(result: Awaited<ReturnType<typeof run>>) {
  const launches = result.wire.filter(event => event.kind === 'serve' || event.kind === 'skills');
  for (const event of launches) {
    expect(event.home).toBe(result.home);
    for (const name of ['data', 'cache', 'state']) {
      expect(event.roots[name]).toMatch(`${result.temp}/`);
      expect(dirname(event.roots[name])).toBe(dirname(event.roots.data));
    }
  }
  const discovery = launches.filter(event => event.config === result.config);
  expect(discovery.length).toBeGreaterThan(0);
  expect(discovery.every(event => event.login === result.auth)).toBe(true);
  const privateHost = launches.filter(event => event.config !== result.config);
  const skills = privateHost.find(event => event.kind === 'skills');
  if (skills) {
    expect(skills.config).toBe(join(dirname(skills.roots.data), 'config'));
    expect(skills.login).toBe(join(result.config, 'muse/auth.json'));
    for (const event of privateHost) {
      expect(event.roots).toEqual(skills.roots);
      expect(event.config).toBe(skills.config);
    }
  }
  for (const dir of [result.data, result.cache, result.state]) {
    const entries = await readdir(dir);
    if (entries.includes('muse')) expect(await readdir(join(dir, 'muse'))).toEqual([]);
    else expect(entries).toEqual([]);
  }
  expect(await readdir(result.qualification)).toEqual([]);
  expect(await readdir(result.work)).toEqual([]);
}

it.skipIf(!nonRoot)('real non-root Pi lists provider models on hard read-only vendor roots', async () => {
  const result = await run('hard-ro', 'list');
  expect(result.wire.filter(event => event.kind === 'catalog').map(event => event.source)).toEqual(['providerCatalog']);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/pi-muse-tether\s+muse-ember-1\.0/);
  expect(result.scratch).toEqual([]);
  await isolated(result);
}, 0);

for (const layout of ['hard-ro', 'granted', 'writable'] as const) {
  it.skipIf(!nonRoot)(`real non-root Pi opens a private host and turns on ${layout} vendor roots`, async () => {
    const result = await run(layout, 'turn', layout === 'hard-ro');
    expect(result.stderr + result.stdout).not.toContain('Muse skill inventory failed');
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('OFFLINE_VENDOR_ROOTS_OK');
    expect(result.wire.filter(event => event.kind === 'denied')).toEqual([]);
    expect(result.wire.filter(event => event.kind === 'session').map(event => event.model)).toEqual([model]);
    expect(result.wire.filter(event => event.kind === 'turn').map(event => [event.effort, event.input])).toEqual([
      ['minimal', [{ type: 'text', text: 'Offline vendor roots test' }]],
    ]);
    expect(await readFile(result.ledger, 'utf8')).toContain('vendor-roots-session');
    expect(result.scratch).toEqual([]);
    await isolated(result);
  }, 0);
}

for (const [failure, mode, visible] of [
  ['catalog', 'list', null],
  ['skills', 'turn', 'Muse skill inventory failed (1); no default fallback'],
  ['replaced-login', 'turn', 'Muse login metadata symlink replaced; STOP'],
] as const) {
  it.skipIf(!nonRoot)(`real non-root Pi handles vendor startup failure: ${failure}`, async () => {
    const result = await run('hard-ro', mode, mode === 'turn', failure);
    if (visible) expect(result.stdout + result.stderr).toContain(visible);
    else expect(result.stdout).not.toMatch(/pi-muse-tether\s+muse-ember-1\.0/);
    expect(result.wire.filter(event => event.kind === 'denied' || event.kind === 'turn')).toEqual([]);
    if (failure === 'replaced-login') {
      const skills = result.wire.find(event => event.kind === 'skills');
      expect(result.scratch).toEqual([basename(dirname(skills.config))]);
      expect(await readFile(join(skills.config, 'muse/auth.json'), 'utf8')).toBe('{}');
    } else expect(result.scratch).toEqual([]);
    await isolated(result);
  }, 0);
}
