import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { quotaPayload, quotaExhausted, quotaStatusLine } from "../src/rate-limit.js";
import { refusal } from "../scripts/live-safety.mjs";

// Exercise the actual driver's quota function, with only its account/transport
// boundary seeded. No Muse process, account read, or inference is possible.
const source = readFileSync(new URL("../scripts/live-verification.mts", import.meta.url), "utf8");
const start = source.indexOf("let forbidden = false;");
const end = source.indexOf('await writeFile(join(out, "doctor.json")', start);
if (start < 0 || end < 0) throw new Error("Verification quota driver boundary moved");
function driver(result: unknown) {
  const rows: any[] = [];
  const stops: any[] = [];
  let closed = 0;
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const run = new Function("out", "log", "denied", "existsSync", "museLaunchOptions", "qualifyMuseVersion", "spawnMspConnection", "env", "quotaPayload", "quotaExhausted", 'const offline = false;\n' + code + '\nreturn quota("seed");');
  const promise = run("synthetic", async (row: any) => { rows.push(row); },
    (value: any) => { const hit = refusal(value); if (hit) stops.push(hit); return !!hit; },
    () => false, () => ({ command: "NEVER-SPAWNED", env: {} }), async () => {},
    () => ({ initialize: async () => ({ connection: { request: async (method: string) => {
      expect(method).toBe("usage/read"); return result;
    } } }), close: async () => { closed++; } }), {}, quotaPayload, quotaExhausted);
  return { promise, rows, stops, closed: () => closed };
}
describe("Verification quota preflight offline seeds", () => {
  it("continues on null server_sent_no_usage and records the native payload", async () => {
    const result = { allowance: null, reason: "server_sent_no_usage", hint: "Can happen before your first use in a new window" };
    const d = driver(result);
    const payload = await d.promise;
    expect(payload.window.usedPercent).toBeNull();
    expect(payload.weekly.usedPercent).toBeNull();
    expect(d.rows).toEqual([{ type: "quota", label: "seed", payload, observation: result }]);
    expect(d.stops).toEqual([]);
    expect(d.closed()).toBe(1);
  });
  for (const dimension of ["window", "weekly"]) {
    it(`stops on real exhausted ${dimension} data even when the other dimension is unknown`, async () => {
      const result = { usage: { [dimension]: { usedPercent: 100 } } }; // vendor exhausted boundary
      const d = driver(result);
      await expect(d.promise).rejects.toThrow("Provider quota exhausted; no candidate prompt submitted");
      expect(d.rows[0].observation).toEqual(result);
      expect(d.stops).not.toEqual([]);
      expect(d.closed()).toBe(1);
    });
  }
  it("still stops on structured plan limit errors without usage", async () => {
    const d = driver({ error: { code: "plan_usage_limit_exceeded" } });
    await expect(d.promise).rejects.toThrow("HTTP 403 quota refusal");
    expect(d.rows).toEqual([]);
    expect(d.stops).not.toEqual([]);
    expect(d.closed()).toBe(1);
  });
});

describe("quota footer line", () => {
  it("is a compact human line, not raw JSON", () => {
    const line = quotaStatusLine(quotaPayload({ tier: "28367280949604159",
      window: { usedPercent: 0, resetsAtMs: 1793744774000, windowDurationMins: 300 },
      weekly: { usedPercent: 1, resetsAtMs: 1794182400000 } }));
    expect(line).toMatch(/^Muse 5h 0% \(resets \d{1,2}[:.]\d{2}.*\) · week 1%$/);
    expect(line).not.toContain("{");
    expect(line).not.toContain("28367");
  });
  it("shows unknown values as ?", () => {
    expect(quotaStatusLine(quotaPayload({ allowance: null }))).toBe("Muse window ? · week ?");
  });
});
