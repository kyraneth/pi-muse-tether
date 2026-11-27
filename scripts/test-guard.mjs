// npm test and native proof entry point. Production targets are read-only.
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync, lstatSync, openSync, readSync, closeSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Fixed-size I/O buffer, not a file-size limit: official clients are large.
function readExtent(fd, start, end, observe) {
  const buffer = Buffer.alloc(64 * 1024);
  for (let pos = start; pos < end;) {
    const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, end - pos), pos);
    if (!bytes) throw new Error('Production target shrank while being observed');
    observe(buffer.subarray(0, bytes));
    pos += bytes;
  }
}
function extentHash(fd, size) {
  const hash = createHash('sha256');
  readExtent(fd, 0, size, part => hash.update(part));
  return hash.digest('hex');
}
function fileHash(path, size) {
  const fd = openSync(path, 'r');
  try { return extentHash(fd, size); } finally { closeSync(fd); }
}
function observeLedger(path, before, runId) {
  try {
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error(`Unsupported request ledger: ${path}`);
      const after = { kind: 'ledger', target: realpathSync(path), dev: stat.dev, ino: stat.ino,
        bytes: stat.size, sha256: extentHash(fd, stat.size) };
      if (!before) return { after };
      const absent = before.kind === 'absent';
      const start = absent ? 0 : before.bytes;
      if (!absent && (after.target !== before.target || after.dev !== before.dev ||
          after.ino !== before.ino || after.bytes < start))
        return { after, error: 'ledger replaced or shrank' };
      if (!absent && (after.bytes === start ? after.sha256 : extentHash(fd, start)) !== before.sha256)
        return { after, error: 'ledger prefix changed' };
      if (after.bytes === start) return { after };
      const boundary = Buffer.alloc(1);
      if (start && (readSync(fd, boundary, 0, 1, start - 1) !== 1 || boundary[0] !== 10))
        return { after, error: 'original ledger does not end at a JSONL record boundary' };
      let lineParts = [], appended = 0, error;
      readExtent(fd, start, after.bytes, part => {
        for (let offset = 0; offset < part.length && !error;) {
          const newline = part.indexOf(10, offset);
          lineParts.push(Buffer.from(part.subarray(offset, newline < 0 ? part.length : newline)));
          if (newline < 0) break;
          try {
            const row = JSON.parse(Buffer.concat(lineParts).toString('utf8'));
            if (row?.origin !== 'live' || row.testRunId === runId)
              error = 'unexpected request ledger writer';
          } catch { error = 'malformed appended request ledger record'; }
          appended++;
          lineParts = [];
          offset = newline + 1;
        }
      });
      if (lineParts.length) error ??= 'incomplete appended request ledger record';
      return { after, appended, error };
    } finally { closeSync(fd); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { after: { kind: 'absent' }, ...(!before || before.kind === 'absent' ? {} : { error: 'ledger removed' }) };
  }
}
export function snapshot(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'link', target: readlinkSync(path), body: snapshot(realpathSync(path)) };
    if (stat.isDirectory()) return { kind: 'directory', entries: Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])) };
    if (!stat.isFile()) throw new Error(`Unsupported production target: ${path}`);
    return { kind: 'file', bytes: stat.size, sha256: fileHash(path, stat.size) };
  } catch (error) { if (error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
}
export function productionTargets(env = process.env, home = homedir()) {
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local/share');
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
    ...productionLedgers(env, home),
    ...(env.PI_MUSE_TETHER_QUALIFICATION_HOME ? [resolve(env.PI_MUSE_TETHER_QUALIFICATION_HOME)] : []),
  ])];
}
function productionLedgers(env = process.env, home = homedir()) {
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local/state');
  const osHomes = new Set([home]);
  try { osHomes.add(userInfo().homedir); } catch { /* passwd entry unavailable */ }
  return new Set([
    ...[...osHomes].map(h => join(h, '.local/state/pi-muse-tether/requests.jsonl')),
    join(state, 'pi-muse-tether/requests.jsonl'),
    ...(env.PI_MUSE_TETHER_LEDGER_PATH && isAbsolute(env.PI_MUSE_TETHER_LEDGER_PATH) ? [resolve(env.PI_MUSE_TETHER_LEDGER_PATH)] : []),
  ]);
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
  const ledgers = productionLedgers(), runId = randomUUID();
  const before = Object.fromEntries(targets.map(path => [path, ledgers.has(path) ? observeLedger(path).after : snapshot(path)]));
  const args = process.argv.slice(2);
  const proof = args[0] === '--proof';
  if (proof) args.shift();
  if (args[0] === '--') args.shift();
  const preload = fileURLToPath(new URL('./test-isolation.mjs', import.meta.url));
  const env = { ...process.env, MUSE_NO_AUTO_UPDATE: '1',
    PI_MUSE_TETHER_LEDGER_ORIGIN: proof ? 'proof' : 'test',
    PI_MUSE_TETHER_TEST_RUN_ID: runId,
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
    const after = {}, changed = [], ledgerAppends = {}, ledgerErrors = {};
    for (const path of allTargets) {
      before[path] ??= { kind: 'absent' };
      if (ledgers.has(path)) {
        const observation = observeLedger(path, before[path], runId);
        after[path] = observation.after;
        if (observation.error) {
          changed.push(path);
          ledgerErrors[path] = observation.error;
        } else if (observation.appended) ledgerAppends[path] = observation.appended;
      } else {
        after[path] = snapshot(path);
        if (JSON.stringify(after[path]) !== JSON.stringify(before[path])) changed.push(path);
      }
    }
    const receipt = { schema: 'pi-muse-tether.isolation/v2', before, after, changed, ledgerAppends, ledgerErrors };
    if (process.env.PI_MUSE_TETHER_ISOLATION_RECEIPT) {
      writeFileSync(process.env.PI_MUSE_TETHER_ISOLATION_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
      console.log('[test-guard] Hash receipt: ' + process.env.PI_MUSE_TETHER_ISOLATION_RECEIPT);
    } else console.log('[test-guard] Hash receipt: ' + JSON.stringify(receipt));
    if (changed.length) throw new Error(`Production state changed during isolated tests/proofs (not restored or modified by guard):\n${changed.map(path => ledgerErrors[path] ? path + ': ' + ledgerErrors[path] : path).join('\n')}`);
    console.log('[test-guard] Production launcher, client binaries, selector, qualification records unchanged; request ledgers passed append-only provenance check.');
  }
  process.exitCode = code;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
