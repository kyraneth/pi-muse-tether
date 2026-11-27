import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { watch, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it.each(['shutdown', 'compact', 'unsolicited', 'inventory', 'before-submit', 'pending-ack', 'admitted', 'tool-abort', 'raw'])(
  'native Pi RPC and subprocess MSP: %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'muse-teardown-rpc-'));
    const msp = join(root, mode), agent = join(root, 'agent'), log = join(msp, 'fixture.jsonl'), sessions = join(root, 'sessions');
    await mkdir(agent); await mkdir(msp);
    await writeFile(log, '');
    const compaction = mode === 'compact' ? { enabled: true, keepRecentTokens: 32000,
      modelOverrides: { 'pi-muse-tether/echo': { reserveTokens: 607997, keepRecentTokens: 32000 } } } : { enabled: false };
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ compaction, retry: { enabled: false } }));
    const rows = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const waiters = new Set<() => void>();
    const watcher = watch(log, () => { for (const wake of waiters) wake(); });
    const child = spawn(resolve('node_modules/.bin/pi'), ['-ne', '-ns', '-np', '-nc', '--no-mcp', '--mode', 'rpc',
      '--provider', 'pi-muse-tether', '--model', 'echo', '--thinking', 'high', ...(mode === 'raw' ? ['--no-tools'] : ['--tools', 'held_tool']),
      '--session-dir', sessions, '-e', resolve('tests/teardown-rpc-fixture.ts')], {
      env: { ...process.env, PI_OFFLINE: '1', PI_MUSE_TETHER_LIVE: '0', PI_CODING_AGENT_DIR: agent,
        PI_MUSE_TETHER_BINARY: resolve('tests/fixtures/teardown-msp.mjs'), TEARDOWN_CASE: mode, TEARDOWN_LOG: log, MUSE_WIRE_DIR: msp },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const wire: any[] = [];
    let stderr = '', closed = false;
    child.stderr.on('data', part => stderr += part);
    createInterface({ input: child.stdout }).on('line', line => {
      try { wire.push(JSON.parse(line)); } catch { return; }
      for (const wake of waiters) wake();
    });
    const exit = new Promise<number | null>(r => child.once('close', code => {
      closed = true; r(code); for (const wake of waiters) wake();
    }));
    let abortSent = false;
    const wait = (find: () => any) => new Promise<any>((resolve, reject) => {
      const check = () => {
        const result = find();
        if (result || closed || wire.some(e => e.type === 'extension_error') || rows().some(e => e.kind === 'degraded') || wire.some(e => e.type === 'message_end' && e.message?.stopReason === 'error') && !abortSent && mode !== 'unsolicited') {
          waiters.delete(check);
          if (result) resolve(result);
          else reject(new Error(`Pi fixture ended early: ${stderr}\n${JSON.stringify(wire.slice(-5))}`));
        }
      };
      waiters.add(check); check();
    });
    const send = (id: string, type: string, message?: string) => child.stdin.write(JSON.stringify({ id, type, message }) + '\n');
    const byKind = (kind: string) => rows().find(row => row.kind === kind);
    const reaped = (pid: number) => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    try {
      send('first', 'prompt', mode === 'compact' ? 'Offline task ' + 'earlier context '.repeat(15000) : 'same text');
      const marker = mode === 'inventory' ? 'inventory' : mode === 'before-submit' ? 'before-submit'
        : mode === 'pending-ack' ? 'start' : mode === 'admitted' || mode === 'raw' ? 'observed-start' : 'tool-execute';
      const held = await wait(() => byKind(marker));
      if (mode === 'shutdown') {
        child.stdin.end();
        expect(await exit, stderr).toBe(0);
      } else if (mode === 'compact') {
        await wait(() => wire.find(e => e.type === 'agent_settled'));
        expect(byKind('compact')?.reason).toBe('threshold');
        expect(wire.some(e => e.type === 'message_end' && e.message?.content?.some?.((p: any) => p.text === 'fixture answer'))).toBe(true);
      } else if (mode === 'unsolicited') {
        process.kill(byKind('serve').pid, 'SIGUSR2');
        expect((await wait(() => byKind('fenced'))).reason).toMatch(/session closed during pending work/);
        await wait(() => wire.find(e => e.type === 'agent_settled'));
      } else {
        abortSent = true;
        send('stop', 'abort');
        expect((await wait(() => wire.find(e => e.id === 'stop' && e.type === 'response'))).success).toBe(true);
        if (mode !== 'tool-abort') expect(wire.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message.stopReason)).toEqual(['aborted']);
        if (mode !== 'inventory') {
          if (['pending-ack', 'admitted', 'tool-abort'].includes(mode)) {
            send('retry-old', 'prompt', '/retry-old');
            expect((await wait(() => byKind('old-result'))).error).toMatch(/no automatic resubmit/);
            expect(rows().filter(row => row.kind === 'start')).toHaveLength(1);
          }
          if (mode !== 'raw') {
            send('fresh', 'prompt', 'same text');
            await wait(() => wire.find(e => e.type === 'message_end' && e.message?.content?.some?.((p: any) => p.text === 'fixture answer')));
          }
        }
      }
      child.stdin.end();
      expect(await exit, stderr).toBe(0);
      if (mode === 'inventory') reaped(held.pid);
      const events = rows(), first = events.find(row => row.kind === 'serve');
      if (first) reaped(first.pid);
      const firstEvents = events.filter(row => row.pid === first?.pid);
      expect(events.filter(row => row.kind === 'fenced')).toHaveLength(mode === 'unsolicited' ? 1 : 0);
      expect(events.filter(row => row.kind === 'tool-execute')).toHaveLength(['shutdown', 'compact', 'unsolicited', 'tool-abort'].includes(mode) ? 1 : 0);
      const cancels = firstEvents.filter(row => row.kind === 'cancel');
      const start = firstEvents.find(row => row.kind === 'start');
      expect(cancels.map(({ sessionId, turnId }) => ({ sessionId, turnId }))).toEqual(
        ['before-submit', 'pending-ack', 'inventory'].includes(mode) ? [] : [{ sessionId: start.sessionId, turnId: start.turnId }]);
      if (mode === 'before-submit') expect(start).toBeUndefined();
      if (mode === 'tool-abort') expect(wire.filter(e => e.type === 'tool_execution_end')).toHaveLength(1);
      if (['before-submit', 'pending-ack', 'admitted', 'tool-abort'].includes(mode)) {
        const journal = (await readFile(join(sessions, (await readdir(sessions))[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        const users = journal.filter(e => e.type === 'message' && e.message.role === 'user');
        expect(users.map(e => e.message.content[0].text)).toEqual(['same text', 'same text']);
        expect(users[0].id).not.toBe(users[1].id);
      }
    } finally {
      if (!closed) child.stdin.end();
      await exit;
      watcher.close();
      // Failure cleanup for the main revision, which leaked the inventory child.
      if (mode === 'inventory' && byKind('inventory')) {
        try { process.kill(byKind('inventory').pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
      await writeFile(join(root, 'rpc.jsonl'), wire.map(e => JSON.stringify(e)).join('\n') + '\n');
      console.log('TEARDOWN_RPC_EVIDENCE', root);
    }
  }, 0);
