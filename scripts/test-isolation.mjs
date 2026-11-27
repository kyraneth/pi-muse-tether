// Shared Vitest setup / Node --import preload. No production writes or launcher calls.
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir, userInfo } from 'node:os';
import { dirname, join, isAbsolute, resolve, sep } from 'node:path';

function canonicalPath(target) {
  const abs = resolve(target);
  const tail = [];
  let cursor = abs;
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return abs;
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      tail.push(cursor.slice(parent.length).replace(/^\/+/, ''));
      cursor = parent;
    }
  }
}
function productionStateRoots() {
  const homes = new Set([homedir()]);
  try { homes.add(userInfo().homedir); } catch { /* passwd entry unavailable */ }
  return [...homes].map(home => canonicalPath(join(home, '.local/state')));
}

const key = Symbol.for('pi-muse-tether.test-isolation');
export function installTestIsolation() {
  if (globalThis[key]) return globalThis[key];
  // Native proofs already own an explicit isolated output tree. Their Pi
  // children must keep that ledger for readback instead of silently relocating
  // it into a second temporary home. Never accept a default production state.
  const proof = process.env.PI_MUSE_TETHER_PROOF_HOME;
  const prodStates = productionStateRoots();
  const safeProofState = process.env.XDG_STATE_HOME && isAbsolute(process.env.XDG_STATE_HOME) &&
    !prodStates.includes(canonicalPath(process.env.XDG_STATE_HOME));
  const safeProofLedger = !process.env.PI_MUSE_TETHER_LEDGER_PATH ||
    (isAbsolute(process.env.PI_MUSE_TETHER_LEDGER_PATH) &&
      !prodStates.map(s => join(s, 'pi-muse-tether/requests.jsonl')).includes(canonicalPath(process.env.PI_MUSE_TETHER_LEDGER_PATH)));
  if (proof && isAbsolute(proof) && resolve(proof) !== homedir() && process.env.MUSE_NO_AUTO_UPDATE === '1' &&
      safeProofState && safeProofLedger &&
      ['XDG_STATE_HOME','XDG_DATA_HOME','PI_MUSE_TETHER_QUALIFICATION_HOME'].every(name => process.env[name]?.startsWith(resolve(proof) + sep))) {
    const isolation = {root:proof,dispose(){}};
    globalThis[key]=isolation; return isolation;
  }
  const root = mkdtempSync(join(tmpdir(), 'pi-muse-tether-isolation-'));
  const values = {
    XDG_STATE_HOME: join(root, 'state'),
    XDG_DATA_HOME: join(root, 'data'),
    PI_MUSE_TETHER_QUALIFICATION_HOME: join(root, 'qualification'),
    PI_MUSE_TETHER_LEDGER_PATH: undefined,
    PI_MUSE_TETHER_LEDGER_ORIGIN: process.env.PI_MUSE_TETHER_LEDGER_ORIGIN === 'proof' ? 'proof' : 'test',
    MUSE_NO_AUTO_UPDATE: '1',
  };
  // Offline suites may execute the official echo client, never the updater.
  // A caller's explicit fixture binary remains authoritative.
  if (!process.env.PI_MUSE_TETHER_BINARY) {
    try {
      const bin = join(homedir(), '.local/bin');
      const build = readFileSync(join(bin, '.muse-version'), 'utf8').trim();
      const direct = join(bin, `muse-bin-${build}`);
      if (/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(build) && existsSync(direct))
        values.PI_MUSE_TETHER_BINARY = direct;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // The wrapper clears inherited live opt-in once. Nested catalogue fixtures
  // deliberately set it with an explicit fake binary; do not erase that intent.
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const name of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'PI_MUSE_TETHER_QUALIFICATION_HOME'])
    mkdirSync(values[name], { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  let disposed = false;
  const isolation = { root, dispose() {
    if (disposed) return;
    disposed = true;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
    delete globalThis[key];
  } };
  globalThis[key] = isolation;
  process.once('exit', () => isolation.dispose());
  return isolation;
}
installTestIsolation();
