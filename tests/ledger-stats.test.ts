import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeMuseLedger } from '../src/ledger-stats.js';
import { museDoctor } from '../src/doctor.js';
const rows = [
  { type: 'request', origin: 'live', requestedModel: 'muse-spark-1.3' },
  { type: 'vendor_retry_scheduled', origin: 'live', requestedModel: 'muse-spark-1.3' },
  { type: 'tool_schema_refusal', origin: 'live', requestedModel: 'muse-ember-1.0' },
  { type: 'episode_start', origin: 'test', requestedModel: 'echo' },
  { type: 'episode_start', origin: 'proof', requestedModel: 'echo' },
  // Pre-0.2.1 rows carry no origin; some are live, some are fixture leftovers.
  { type: 'episode_start', requestedModel: 'echo' },
  { type: 'tool_schema_refusal', requestedModel: 'echo' },
];
function ledger() {
  const root = mkdtempSync(join(tmpdir(), 'muse-ledger-stats-'));
  const path = join(root, 'pi-muse-tether/requests.jsonl');
  mkdirSync(join(root, 'pi-muse-tether'), { recursive: true });
  writeFileSync(path, [...rows.map(row => JSON.stringify(row)), '{"type":"request","piSess'].join('\n') + '\n');
  return { root, path };
}
afterEach(() => vi.unstubAllEnvs());
it('counts live rows only and names every excluded bucket', async () => {
  const { root, path } = ledger();
  try {
    const summary: any = await summarizeMuseLedger(path);
    expect(summary).toMatchObject({ path, present: true, rows: 8, counted: { origin: 'live', rows: 3 } });
    expect(summary.live.byType).toEqual({ request: 1, tool_schema_refusal: 1, vendor_retry_scheduled: 1 });
    expect(summary.live.byModel).toEqual({ 'muse-spark-1.3': 2, 'muse-ember-1.0': 1 });
    expect(Object.fromEntries(summary.excluded.map((bucket: any) => [bucket.kind, bucket.rows]))).toEqual({ test: 1, proof: 1, unknown: 2, unreadable: 1 });
    for (const bucket of summary.excluded) expect(bucket.reason.length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('lists exclusions in a fixture-free ledger as empty, not zero-filled', async () => {
  const { root, path } = ledger();
  try {
    writeFileSync(path, JSON.stringify({ type: 'request', origin: 'live', requestedModel: 'muse-wonder-1.0' }) + '\n');
    const summary: any = await summarizeMuseLedger(path);
    expect(summary).toMatchObject({ rows: 1, counted: { origin: 'live', rows: 1 }, excluded: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('reports an absent ledger without inventing rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-ledger-absent-'));
  try {
    const summary: any = await summarizeMuseLedger(join(root, 'pi-muse-tether/requests.jsonl'));
    expect(summary).toMatchObject({ present: false, rows: 0, counted: { origin: 'live', rows: 0 }, excluded: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('/muse-doctor ledger returns the same summary through the command entry', async () => {
  const { root, path } = ledger();
  try {
    vi.stubEnv('XDG_STATE_HOME', root);
    const output = JSON.parse(await museDoctor(undefined, 'ledger'));
    expect(output).toMatchObject({ path, rows: 8, counted: { origin: 'live', rows: 3 } });
    expect(output.live.byType.tool_schema_refusal).toBe(1);
    await expect(museDoctor(undefined, 'ledger now')).rejects.toThrow(/Usage: \/muse-doctor ledger/);
    await expect(museDoctor(undefined, 'nope')).rejects.toThrow(/Unknown \/muse-doctor command/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
