import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { museLedgerPath } from "./request-ledger.js";
/** Why a row is not counted as live traffic. */
const EXCLUSIONS: Record<string, string> = {
  test: "runner-isolated test row (VITEST, NODE_TEST_CONTEXT or PI_MUSE_TETHER_LEDGER_ORIGIN=test)",
  proof: "proof row (PI_MUSE_TETHER_LEDGER_ORIGIN=proof)",
  unknown: "row carries no origin (written by a tether older than 0.2.1); provenance is not recorded",
  unreadable: "line is not valid JSON (partial append at a crash)",
};
function bump(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}
function ranked(counts: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}
/**
 * Counts live ledger rows only, split by event type and requested model, and
 * reports every excluded row with its reason. Fixture, proof and pre-0.2.1 rows
 * are never silently folded into traffic; count typed rows here rather than
 * grepping the file.
 */
export async function summarizeMuseLedger(path = museLedgerPath()) {
  const byOrigin: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let rows = 0, unreadable = 0, live = 0;
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      rows++;
      let row: any;
      try { row = JSON.parse(text); } catch { unreadable++; continue; }
      const origin = typeof row.origin === "string" ? row.origin : "unknown";
      bump(byOrigin, origin);
      if (origin !== "live") continue;
      live++;
      bump(byType, typeof row.type === "string" ? row.type : "unknown");
      bump(byModel, typeof row.requestedModel === "string" ? row.requestedModel : "unknown");
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return { path, present: false, rows: 0, counted: { origin: "live", rows: 0 }, excluded: [], live: { byType: {}, byModel: {} } };
  }
  const excluded = Object.entries(byOrigin)
    .filter(([origin]) => origin !== "live")
    .map(([kind, count]) => ({ kind, rows: count, reason: EXCLUSIONS[kind] ?? "unrecognised origin; not treated as live traffic" }));
  if (unreadable) excluded.push({ kind: "unreadable", rows: unreadable, reason: EXCLUSIONS.unreadable! });
  return { path, present: true, rows, counted: { origin: "live", rows: live }, excluded, live: { byType: ranked(byType), byModel: ranked(byModel) } };
}
