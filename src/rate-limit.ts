const num = (v: any) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
export function quotaPayload(u: any) {
  return {
    source: "native:Muse-usage/read-or-usage/changed",
    observedAtMs: num(u?.observedAtMs),
    tier: typeof u?.tier === "string" ? u.tier : null,
    window: {
      usedPercent: num(u?.window?.usedPercent),
      resetsAtMs: num(u?.window?.resetsAtMs),
      windowDurationMins: num(u?.window?.windowDurationMins),
    },
    weekly: {
      usedPercent: num(u?.weekly?.usedPercent),
      resetsAtMs: num(u?.weekly?.resetsAtMs),
    },
  };
}
/** Compact footer line; the full native payload stays in the request ledger. */
export function quotaStatusLine(p: ReturnType<typeof quotaPayload>) {
  const pct = (v: number | null) => (v === null ? "?" : `${Math.round(v)}%`);
  const at = (ms: number | null) => ms === null ? "" :
    ` (resets ${new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
  const mins = p.window.windowDurationMins;
  const span = mins === null ? "window" : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
  return `Muse ${span} ${pct(p.window.usedPercent)}${at(p.window.resetsAtMs)} · week ${pct(p.weekly.usedPercent)}`;
}
export function quotaExhausted(u: any) {
  return u?.window?.usedPercent >= 100 || u?.weekly?.usedPercent >= 100;
} // vendor exhausted boundary
let listener: ((p: ReturnType<typeof quotaPayload>) => void) | undefined;
let lastIdentity: string | undefined;
export function setQuotaListener(fn: typeof listener) {
  lastIdentity = undefined;
  listener = fn;
}
export function publishQuota(u: any) {
  try {
    const payload = quotaPayload(u);
    const { observedAtMs: _, ...state } = payload;
    const identity = JSON.stringify(state);
    if (identity === lastIdentity) return;
    lastIdentity = identity;
    listener?.(payload);
  } catch {
    /* status cannot break requests */
  }
}
