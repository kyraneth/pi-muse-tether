export const NATIVE_SEARCH_TOOL = "web_search";
export const NATIVE_SEARCH_NOTICE = "Muse may search the web itself; its searches and sources appear here.";
export const NATIVE_SEARCH_NOTICE_ENTRY = "pi-muse-tether:native-search-notice";
export const NATIVE_SEARCH_ENTRY = "pi-muse-tether:native-search";

export const nativeSearchRequested = () => process.env.PI_MUSE_TETHER_NATIVE_SEARCH === "1";
export const strictMuse = () => process.env.PI_MUSE_TETHER_STRICT === "1";
export const nativeSearchRefusal = "PI_MUSE_TETHER_STRICT=1 refuses native Muse web search. Unset PI_MUSE_TETHER_NATIVE_SEARCH; no prompt was sent.";

export type NativeSearchEntry = {
  sessionId: string;
  turnId: string;
  callId: string;
  query: string | null;
} & ({ phase: "started" } | {
  phase: "completed";
  status: "completed" | "failed" | "cancelled" | "unknown";
  sources: { title: string; url: string }[] | null;
});
export interface NativeSearchSurface {
  announce(): void;
  record(entry: NativeSearchEntry): void;
}

function parse(value: unknown) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { /* clipped, malformed, or a vendor error */ }
  }
}

export function searchQuery(args: unknown): string | null {
  const q = parse(args)?.query;
  return typeof q === "string" && q.trim() ? q : null;
}

export function searchSources(item: Record<string, unknown>, query: string | null): Extract<NativeSearchEntry, {phase:"completed"}>["sources"] {
  if (item.status !== "completed" || item.truncated === true || query === null) return null;
  const result = parse(item.visibleOutput);
  if (result?.query !== query || !Array.isArray(result.results)) return null;
  const sources: NonNullable<ReturnType<typeof searchSources>> = [];
  for (const {title, url} of result.results.filter(row => row && typeof row === "object")) {
    if (typeof title !== "string" || typeof url !== "string" || !/^https?:\/\//i.test(url) || !URL.canParse(url)) continue;
    sources.push({title, url});
  }
  return sources.length || !result.results.length ? sources : null;
}

/** Display untrusted strings literally; escape terminal controls and bidi overrides. */
const printable = (str: string) => JSON.stringify(str).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
  c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
export function nativeSearchLabel(entry: NativeSearchEntry): string {
  const query = entry.query === null ? "(query unavailable)" : printable(entry.query);
  const prefix = `[Muse native search] ${query}`;
  if (entry.phase === "started") return `${prefix} — started`;
  const status = `${prefix} — ${entry.status === "unknown" ? "ended (status unavailable)" : entry.status}`;
  if (!entry.sources) return `${status}; sources unavailable`;
  if (!entry.sources.length) return `${status}; no sources returned`;
  return [status, ...entry.sources.map(({title,url}) => `  ${printable(title)} — ${printable(url)}`)].join("\n");
}
