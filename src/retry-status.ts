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
export function publishRetryStatus(owner: object, params?: Record<string, any>) {
  statuses.delete(owner);
  if(params)statuses.set(owner, `Muse retry ${params.nextAttempt}/${params.maxAttempts} scheduled in ${params.retryDelayMs} ms (${params.errorKind}${params.httpStatus === undefined ? "" : `, HTTP ${params.httpStatus}`})`);
  listener?.([...statuses.values()].at(-1));
}
