// npm test and native proof entry point. Production targets are read-only.
import { createHash } from 'node:crypto';
import { lstatSync, openSync, readSync, closeSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

function fileHash(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  // Fixed-size I/O buffer, not a file-size limit: official clients are large.
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) !== 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
export function snapshot(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'link', target: readlinkSync(path), body: snapshot(realpathSync(path)) };
    if (stat.isDirectory()) return { kind: 'directory', entries: Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])) };
    if (!stat.isFile()) throw new Error(`Unsupported production target: ${path}`);
    return { kind: 'file', bytes: stat.size, sha256: fileHash(path) };
  } catch (error) { if (error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
}
export function productionTargets(env = process.env, home = homedir()) {
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local/share');
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local/state');
  const bin = join(home, '.local/bin');
  let clients = [];
  try { clients = readdirSync(bin).filter(name => name.startsWith('muse-bin-')).sort().map(name => join(bin, name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [...new Set([
    join(bin, '.muse-version'),
    join(bin, 'muse'),
    ...clients,
    join(home, '.local/share/pi-muse-tether/qualifications'),
    join(data, 'pi-muse-tether/qualifications'),
    join(home, '.local/state/pi-muse-tether/requests.jsonl'),
    join(state, 'pi-muse-tether/requests.jsonl'),
    ...(env.PI_MUSE_TETHER_QUALIFICATION_HOME ? [resolve(env.PI_MUSE_TETHER_QUALIFICATION_HOME)] : []),
  ])];
}
export async function runTestPhases(run, report = console.log) {
  const phases = [
    { name: 'Vitest', args: ['node_modules/vitest/vitest.mjs', 'run', 'tests', '--exclude', 'tests/host.test.ts', '--reporter=verbose', '--testTimeout=0', '--hookTimeout=0'] },
    { name: 'node:test', args: ['--import', 'tsx', '--test', '--test-reporter=spec', 'tests/host.test.ts', 'tests/catalog-entry.node.ts'] },
  ];
  const results = [];
  for (const phase of phases) {
    report(`[test-guard] START ${phase.name}`);
    let code;
    try { code = await run(process.execPath, phase.args); }
    catch (error) { code = 1; report(`[test-guard] ${phase.name} failed to launch: ${error.message}`); }
    results.push(code);
    report(`[test-guard] END ${phase.name}: exit ${code}`);
  }
  return results.some(code => code !== 0) ? 1 : 0;
}
async function main() {
  const targets = productionTargets();
  const before = Object.fromEntries(targets.map(path => [path, snapshot(path)]));
  const args = process.argv.slice(2);
  const proof = args[0] === '--proof';
  if (proof) args.shift();
  if (args[0] === '--') args.shift();
  const preload = fileURLToPath(new URL('./test-isolation.mjs', import.meta.url));
  const env = { ...process.env, MUSE_NO_AUTO_UPDATE: '1',
    PI_MUSE_TETHER_LEDGER_ORIGIN: proof ? 'proof' : 'test',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`.trim(),
  };
  if (!proof) delete env.PI_MUSE_TETHER_LIVE;
  const run = (command, argv) => new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env, stdio: 'inherit' });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
  let code = 1;
  try {
    if (args.length) code = await run(args[0], args.slice(1));
    else code = await runTestPhases(run);
  } finally {
    // Re-enumerate: the updater could have added a build or removed an old one.
    const allTargets = [...new Set([...targets, ...productionTargets()])];
    const after = Object.fromEntries(allTargets.map(path => [path, snapshot(path)]));
    for (const path of allTargets) before[path] ??= { kind: 'absent' };
    const changed = allTargets.filter(path => JSON.stringify(after[path]) !== JSON.stringify(before[path]));
    const receipt = { schema: 'pi-muse-tether.isolation/v1', before, after, changed };
    if (process.env.PI_MUSE_TETHER_ISOLATION_RECEIPT) {
      writeFileSync(process.env.PI_MUSE_TETHER_ISOLATION_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
      console.log('[test-guard] Hash receipt: ' + process.env.PI_MUSE_TETHER_ISOLATION_RECEIPT);
    } else console.log('[test-guard] Hash receipt: ' + JSON.stringify(receipt));
    if (changed.length) throw new Error(`Production state changed during isolated tests/proofs (not restored or modified by guard):\n${changed.join('\n')}`);
    console.log('[test-guard] Production launcher, client binaries, selector, qualification records and request ledgers unchanged.');
  }
  process.exitCode = code;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
