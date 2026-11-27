import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { metadataLedger } from "pi-tether-core/metadata-ledger";
import { museRequestUsage } from "./usage.js";
import { museResponseIdentity } from "./model-route.js";
import { quotaPayload } from "./rate-limit.js";
const packageVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
function ledgerOrigin(): 'live' | 'test' | 'proof' {
  if (process.env.VITEST || process.env.NODE_TEST_CONTEXT) return 'test';
  const origin = process.env.PI_MUSE_TETHER_LEDGER_ORIGIN;
  return origin === 'test' || origin === 'proof' ? origin : 'live';
}
/** Resolve symlinks on the nearest existing ancestor so symlinked state dirs cannot alias production. */
function canonicalPath(target: string): string {
  const abs = resolve(target);
  const tail: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return abs;
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      tail.push(cursor.slice(parent.length).replace(/^\/+/, ''));
      cursor = parent;
    }
  }
}
function productionLedgerPaths(): string[] {
  const homes = new Set<string>([homedir()]);
  try { homes.add(userInfo().homedir); } catch { /* passwd entry unavailable */ }
  return [...homes].map(home => canonicalPath(join(home, '.local/state/pi-muse-tether/requests.jsonl')));
}
const num = (v: any) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
export function museLedgerPath() {
  const explicit = process.env.PI_MUSE_TETHER_LEDGER_PATH;
  const state = process.env.XDG_STATE_HOME;
  // XDG Base Directory requires absolute values; empty/relative values are
  // treated as unset, never a request to write metadata beneath the cwd.
  const hasExplicit = Boolean(explicit && isAbsolute(explicit));
  const path = hasExplicit
    ? resolve(explicit!)
    : join(
        state && isAbsolute(state) ? state : join(homedir(), ".local/state"),
        "pi-muse-tether",
        "requests.jsonl",
      );
  if (ledgerOrigin() !== 'live') {
    const prodPaths = productionLedgerPaths();
    const resolved = canonicalPath(path);
    if ((!hasExplicit && (!state || !isAbsolute(state))) || prodPaths.includes(resolved)) {
      throw new Error('Test/proof request ledger requires an isolated absolute XDG_STATE_HOME or PI_MUSE_TETHER_LEDGER_PATH; refusing the production ledger.');
    }
  }
  return path;
}
let writer: ReturnType<typeof metadataLedger> | undefined, path: string;
function append(row: any) {
  const p = museLedgerPath();
  if (p !== path) {
    path = p;
    writer = metadataLedger(p);
  }
  writer!.append(row);
}
export async function flushMuseLedger() {
  await writer?.flush();
}
export type PlanEpisode = {id:string; phase:"stage"|"final"; index:number; turns:number};
export class MuseLedger {
  readonly processId = randomUUID();
  private sessionId: string | null = null;
  private episodeId: string | null = null;
  private triggerMode: "spawn" | "turn" | "handoff" | null = null;
  private seen = new Set<string>();
  private plan?: PlanEpisode;
  constructor(
    private piSessionId: string | null,
    private requestedModel: string | null,
    private contributorMode: "on" | "off" = "on",
    private pickerModel: string | null = requestedModel,
  ) {
    this.record("process_spawn");
  }
  record(type: string, fields: Record<string, unknown> = {}) {
    append({
      type,
      pid: null,
      processId: this.processId,
      piSessionId: this.piSessionId,
      cliSessionId: this.sessionId,
      requestedModel: this.requestedModel,
      pickerModel: this.pickerModel,
      contributorMode: this.contributorMode,
      episodeId: this.episodeId,
      triggerMode: this.triggerMode,
      ...(this.plan ? {planId:this.plan.id,planPhase:this.plan.phase,planIndex:this.plan.index,planTurns:this.plan.turns} : {}),
      ...fields,
      // Provenance is owned here; caller fields cannot masquerade as live traffic.
      origin: ledgerOrigin(),
      testRunId: process.env.PI_MUSE_TETHER_TEST_RUN_ID,
      packageVersion,
    });
  }
  opened(id: string) {
    this.sessionId = id;
    this.record("process_init");
  }
  beginEpisode(mode: "spawn" | "turn" | "handoff" = "spawn", plan?:PlanEpisode) {
    this.triggerMode = mode;
    this.plan = plan;
    this.episodeId = randomUUID();
    this.record("episode_start");
  }
  endEpisode() {
    if (this.episodeId === null) return;
    this.record("episode_end");
    this.episodeId = null;
    this.triggerMode = null;
    this.plan = undefined;
  }
  observe(frame: any) {
    const p = frame.params ?? {};
    if (["turn/retryScheduled", "turn/modelRetryScheduled"].includes(frame.method)) {
      this.record("vendor_retry_scheduled", {
        method: frame.method, turnId: p.turnId ?? null,
        attempt: num(p.attempt), nextAttempt: num(p.nextAttempt), maxAttempts: num(p.maxAttempts),
        retryDelayMs: num(p.retryDelayMs), httpStatus: num(p.httpStatus),
        errorKind: typeof p.errorKind === "string" ? p.errorKind : null,
        reason: typeof p.reason === "string" ? p.reason : null,
        system: typeof p.system === "string" ? p.system : null,
        sourceRange: p.sourceRange ?? null, viewCursor: p.viewCursor ?? null,
      });
    }
    if (frame.method === "session/tokenUsage") {
      const id = p.sourceRange?.last?.id ?? p.viewCursor;
      if (typeof id !== "string" || this.seen.has(id)) return;
      this.seen.add(id);
      const { native, referenceCost, referenceCostSource, referenceCostPartial } = museRequestUsage(this.pickerModel, p);
      const { responseModel, responseModelSource } = this.pickerModel ? museResponseIdentity(this.pickerModel) : {};
      this.record("request", {
        requestId: id,
        turnId: typeof p.turnId === "string" ? p.turnId : null,
        // MSP reports a logical alias here; it does not attest the HTTP model.
        nativeReportedModel: typeof p.modelId === "string" ? p.modelId : null,
        physicalModel: null,
        physicalModelSource: "unknown:MSP-usage-does-not-attest-physical-model",
        usage: native,
        responseModel: responseModel ?? null,
        responseModelSource: responseModelSource ?? null,
        referenceCost,
        referenceCostSource,
        referenceCostPartial,
        promptTokens: num(p.promptTokens),
        totalTokens: num(p.totalTokens),
        durationMs: num(p.durationMs),
        receivedDetached: this.episodeId === null,
      });
      const c = p.cumulative;
      this.record("cumulative", {
        promptTokens: num(c?.promptTokens),
        outputTokens: num(c?.outputTokens),
        totalTokens: num(c?.totalTokens),
        cacheReadTokens: num(c?.cacheReadTokens),
        cacheWriteTokens: num(c?.cacheWriteTokens),
        costUsd: num(c?.cost?.usd),
        costPartial:
          typeof c?.cost?.partial === "boolean" ? c.cost.partial : null,
      });
    }
  }
  quota(u: any) {
    this.record("rate_limit", quotaPayload(u));
  }
  retire(reason: string, cause?: string) {
    this.endEpisode();
    this.record("retire", cause ? { reason, cause } : { reason });
  }
}
