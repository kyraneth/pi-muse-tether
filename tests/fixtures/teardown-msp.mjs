#!/usr/bin/env node
// Offline MSP peer; no model inference or account access.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { EXPECTED_SCHEMA_FINGERPRINT } from '@muse-code/sdk';
const mode = basename(process.env.MUSE_WIRE_DIR);
const log = join(process.env.MUSE_WIRE_DIR, 'fixture.jsonl');
const record = (kind, fields = {}) => appendFileSync(log, JSON.stringify({ kind, pid: process.pid, ...fields }) + '\n');
if (process.argv.includes('--version')) {
  console.log('Muse Code 1.4.14 (1.4.14-R7309.1)');
} else if (process.argv[2] === 'skills') {
  if (mode === 'inventory') {
    // Hold until killed; this keeps the child observable without a timer.
    // stdin is /dev/null; a watcher, not the closed pipe, owns the hold.
    const { watch } = await import('node:fs');
    watch(log, () => {});
    record('inventory');
  } else console.log('[]');
} else {
  const first = !readFileSync(log, 'utf8').includes('"kind":"serve"');
  const raw = process.argv.includes('run.toolset=[]');
  record('serve', { first, raw });
  const write = (frame) => console.log(JSON.stringify({ jsonrpc: '2.0', ...frame }));
  const sessionId = `session-${process.pid}`;
  let turnId;
  let sequence = 0;
  const notify = (method, params = {}) => write({ method, params: {
    sessionId, turnId, viewCursor: String(++sequence), sourceRange: {}, ...params,
  } });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    const reply = result => write({ id, result });
    switch (method) {
      case 'initialize':
        reply({ protocolVersion: '1', serverInfo: { name: 'fixture', version: '1.4.14' }, schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT }, sessionDurability: 'ephemeral', grantedCapabilities: ['sessionMcp', 'rawLog'], experimentalApi: true });
        break;
      case 'session/start':
        reply({ session: { sessionId, permissionState: { reviewerAuthority: 'human' } }, viewCursor: '0' });
        break;
      case 'log/streams': reply({ streams: [{ stream: { kind: 'session.live', id: sessionId } }] }); break;
      case 'log/subscribe': reply({ subscriptionId: 1 }); break;
      case 'mcpServer/readInventory':
        if (first && mode === 'before-submit') { record('before-submit'); break; }
        reply({ servers: [{ name: 'pi', state: 'connected', tools: ['held_tool'] }] });
        break;
      case 'turn/start': {
        turnId = `turn-${params.commandId}`;
        record('start', { sessionId, turnId });
        if (first && mode === 'pending-ack') break;
        reply({ commandId: params.commandId, status: 'accepted', disposition: 'started', startedNewTurn: true, turnId });
        notify('turn/started', { commandId: params.commandId });
        if (first && ['shutdown', 'tool-abort', 'unsolicited', 'compact'].includes(mode)) {
          if (mode === 'compact') notify('session/tokenUsage', { usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalTokens: 127 });
          const call = { call_id: 'held-call', name: 'mcp__pi__held_tool', args: {} };
          write({ method: 'log/record', params: { subscriptionId: 1, record: { schema_version: 1,
            sequence: 1, recorded_at: 1, id: 'held-batch', causation_id: null, durability: 'ephemeral', stream: { kind: 'session.live', id: sessionId },
            record_type: 'event', payload_type: 'run', payload_schema_version: 1,
            payload: { kind: 'run', run_id: turnId, event: { kind: 'assistant_tool_calls_committed', tool_calls: [call] } },
          } } });
        } else if (!first || !['admitted', 'raw'].includes(mode)) {
          notify('item/started', { item: { kind: 'agentMessage', itemId: 'answer' } });
          const text = raw ? '## Goal\nPreserve offline earlier task.' : 'fixture answer';
          notify('item/delta', { itemId: 'answer', field: 'text', delta: text });
          if (raw) notify('session/tokenUsage', { usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalTokens: 127 });
          notify('turn/completed', { terminal: 'completed' });
        }
        break;
      }
      case 'turn/cancel':
        record('cancel', { sessionId: params.sessionId, turnId: params.turnId });
        // Deliberately do not ack. EOF and reaping cannot depend on this answer.
        break;
    }
  }).on('close', () => {
    if (turnId) notify('session/closed', { reason: 'hostShutdown' });
    record('eof');
  });
  // The test triggers a genuinely unsolicited close while Pi is in the tool.
  process.on('SIGUSR2', () => notify('session/closed', { reason: 'hostShutdown' }));
}
