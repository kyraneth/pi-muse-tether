/** Extension UI status only, never assistant/model content or a retry scheduler. */
let listener: ((status: string | undefined) => void) | undefined;
export function setRetryStatusListener(next: typeof listener) { listener = next; }
const statuses = new Map<object, string>();
/** Reuses Pi's supported status listener; never emits model/assistant content. */
export function publishRedactionStatus(owner: object, count: number) {
  statuses.delete(owner);
  statuses.set(owner, `Muse redacted ${count} tool-result span${count === 1 ? "" : "s"} (vendor limit; not byte-exact model input)`);
  listener?.([...statuses.values()].at(-1));
}
const text = (v: unknown) => (typeof v === "string" && v.trim().length ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Extract the real underlying cause from a retry notification without rendering undefined/null. */
export function retryCause(params?: Record<string, any>): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const detail = text(params.errorKind) ?? text(params.reason) ?? text(params.error?.message) ?? text(params.error?.kind);
  const parts = [text(params.system), detail].filter((v): v is string => Boolean(v));
  return parts.length ? parts.join(": ") : undefined;
}

export function publishRetryStatus(owner: object, params?: Record<string, any>) {
  statuses.delete(owner);
  if(params){
    // The durable retry kind and HTTP status are optional open-vocabulary vendor
    // fields; the recorded stopping reason is the real cause when either is absent.
    const cause = retryCause(params);
    const nextAttempt = num(params.nextAttempt);
    const maxAttempts = num(params.maxAttempts);
    const retryDelayMs = num(params.retryDelayMs);
    const httpStatus = num(params.httpStatus);
    const attempt = nextAttempt !== undefined && maxAttempts !== undefined
      ? ` ${nextAttempt}/${maxAttempts}`
      : nextAttempt !== undefined
        ? ` ${nextAttempt}`
        : "";
    const delay = retryDelayMs !== undefined ? ` in ${retryDelayMs} ms` : "";
    const status = httpStatus !== undefined ? `, HTTP ${httpStatus}` : "";
    statuses.set(owner, `Muse retry${attempt} scheduled${delay} (${cause || "cause not reported"}${status})`);
  }
  listener?.([...statuses.values()].at(-1));
}
