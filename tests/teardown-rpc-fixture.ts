import { appendFileSync } from 'node:fs';
import { Type } from 'typebox';
import { registerMuseExtension } from '../index.ts';
import { createMuseProvider } from '../src/provider.ts';
import { openMuseHost } from '../src/host.ts';

export default async function (pi: any) {
  const mode = process.env.TEARDOWN_CASE;
  const log = process.env.TEARDOWN_LOG!;
  const record = (kind: string, fields: object = {}) => appendFileSync(log, JSON.stringify({ kind, ...fields }) + '\n');
  const replace = mode === 'inventory' || mode === 'raw' || mode === 'compact';
  const provider = createMuseProvider({
    toolBatches: !replace || mode === 'compact',
    promptModes: replace ? ['replace'] : ['none'],
    promptMode: replace ? 'replace' : 'none',
    instructionMechanisms: replace ? ['private-xdg-settings'] : [],
    rawCompletion: replace,
    openHost: options => openMuseHost({ ...options, onEvent: event => {
      if (event.kind === 'degraded') record('degraded', { reason: event.reason });
      if (event.kind === 'fenced') record('fenced', { reason: event.reason });
      if (event.kind === 'frame' && event.frame.method === 'turn/started') record('observed-start');
      options.onEvent?.(event);
    } }),
  });
  if (mode !== 'raw') pi.registerTool({
    name: 'held_tool', label: 'Held tool', description: 'Offline held tool', parameters: Type.Object({}),
    async execute(_id: string, _args: unknown, signal: AbortSignal) {
      record('tool-execute');
      if (mode === 'compact') {
        // Same synthetic tool-output workload as the dedicated RPC compaction fixture.
        return { content: [{ type: 'text', text: 'a'.repeat(2 * 840000) }] };
      }
      if (mode !== 'unsolicited' && !signal.aborted)
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { content: [{ type: 'text', text: 'fixture tool result' }] };
    },
  });
  // Ask the same provider to process the old native branch again (with a new
  // extension-generated message in context, but without a new native user).
  pi.registerCommand('retry-old', { description: 'Probe replay fence', async handler(_args: unknown, ctx: any) {
    const messages = ctx.sessionManager.getBranch().filter((e: any) => e.type === 'message').map((e: any) => e.message);
    messages.push({ role: 'user', content: 'extension-generated', timestamp: Date.now() });
    const answer = await provider.streamViaMuse(ctx.model, { systemPrompt: '', messages,
      tools: [{ name: 'held_tool', description: 'Offline held tool', parameters: Type.Object({}) }],
    }, { sessionId: ctx.sessionManager.getSessionId() }).result();
    record('old-result', { reason: answer.stopReason, error: answer.errorMessage });
  } });
  await registerMuseExtension(pi, provider, mode === 'compact' ? { contextWindow: 1007997, maxTokens: 128000 } : undefined);
  if (mode === 'compact') {
    pi.on('session_start', (_event: any, ctx: any) => {
      const timestamp = Date.now();
      ctx.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Offline earlier task' }], timestamp });
      ctx.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Earlier task complete' }],
        api: 'pi-muse-tether', provider: 'pi-muse-tether', model: 'echo', stopReason: 'stop', timestamp,
        usage: { input: 120, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 127, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    });
    pi.on('session_compact', (event: any) => record('compact', { reason: event.reason }));
  }
}
