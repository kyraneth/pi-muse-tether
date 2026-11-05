import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { metadataLedger } from "pi-tether-core/metadata-ledger";
import { nativeCounters } from "./usage.js";
import { quotaPayload } from "./rate-limit.js";
const num = (v: any) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
export function museLedgerPath() {
  const state = process.env.XDG_STATE_HOME;
  // XDG Base Directory requires absolute values; empty/relative values are
  // treated as unset, never a request to write metadata beneath the cwd.
  return join(
    state && isAbsolute(state) ? state : join(homedir(), ".local/state"),
    "pi-muse-tether",
    "requests.jsonl",
  );
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
export class MuseLedger {
  readonly processId = randomUUID();
  private sessionId: string | null = null;
  private episodeId: string | null = null;
  private triggerMode: "spawn" | "turn" | "handoff" | null = null;
  private seen = new Set<string>();
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
      ...fields,
    });
  }
  opened(id: string) {
    this.sessionId = id;
    this.record("process_init");
  }
  beginEpisode(mode: "spawn" | "turn" | "handoff" = "spawn") {
    this.triggerMode = mode;
    this.episodeId = randomUUID();
    this.record("episode_start");
  }
  endEpisode() {
    if (this.episodeId === null) return;
    this.record("episode_end");
    this.episodeId = null;
    this.triggerMode = null;
  }
  observe(frame: any) {
    const p = frame.params ?? {};
    if (["turn/retryScheduled", "turn/modelRetryScheduled"].includes(frame.method)) {
      this.record("vendor_retry_scheduled", {
        method: frame.method, turnId: p.turnId ?? null,
        attempt: num(p.attempt), nextAttempt: num(p.nextAttempt), maxAttempts: num(p.maxAttempts),
        retryDelayMs: num(p.retryDelayMs), httpStatus: num(p.httpStatus),
        errorKind: typeof p.errorKind === "string" ? p.errorKind : null,
        system: typeof p.system === "string" ? p.system : null,
        sourceRange: p.sourceRange ?? null, viewCursor: p.viewCursor ?? null,
      });
    }
    if (frame.method === "session/tokenUsage") {
      const id = p.sourceRange?.last?.id ?? p.viewCursor;
      if (typeof id !== "string" || this.seen.has(id)) return;
      this.seen.add(id);
      this.record("request", {
        requestId: id,
        turnId: typeof p.turnId === "string" ? p.turnId : null,
        // MSP reports a logical alias here; it does not attest the HTTP model.
        nativeReportedModel: typeof p.modelId === "string" ? p.modelId : null,
        physicalModel: null,
        physicalModelSource: "unknown:MSP-usage-does-not-attest-physical-model",
        usage: nativeCounters(p.usage),
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
