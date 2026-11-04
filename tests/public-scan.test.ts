import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { normalizeForScan, scanText, publicPatterns } from "../scripts/check-public-tree.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const script = join(root, "scripts", "check-public-tree.mjs");

const run = (env = {}) =>
  JSON.parse(execFileSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  }));

// Probe strings are assembled at runtime from separate fragments so this
// test file itself never contains a matchable secret, host or credential
// shape — the whole tree is scanned by the policy runs above.
const fragments = (...parts: string[]) => parts.join("");

describe("public tree scanner policy interface", () => {
  it("runs generic checks and reports policyApplied:false without any policy", () => {
    const result = run({ PUBLIC_SCAN_POLICY: join(root, "internal", "no-such-policy.json") });
    expect(result.status).toBe("not-applied");
    expect(result.policyApplied).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.packFiles).toBeGreaterThan(0);
  });

  it("applies an external private policy and reports policyApplied:true", () => {
    // A clean public checkout has no internal policy directory; the private
    // policy lives outside the checkout and is supplied explicitly. Use a
    // fresh temporary directory so nothing policy-shaped lands in the tree.
    const dir = mkdtempSync(join(tmpdir(), "public-scan-policy-"));
    const policyPath = join(dir, "external-policy.json");
    // Marker assembled from fragments so this file never contains the
    // contiguous term it writes into the temporary policy.
    const marker = ["reserved-", "synthetic-", "policy-", "marker-", "never-", "present"].join("");
    writeFileSync(policyPath, JSON.stringify({
      bannedTerms: [marker],
      privatePatterns: [],
    }));
    try {
      const result = run({ PUBLIC_SCAN_POLICY: policyPath });
      expect(result.status).toBe("clear");
      expect(result.policyApplied).toBe(true);
      expect(result.findings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes exactly the generic pattern set and no private policy", () => {
    expect(publicPatterns.map(p => p[0])).toEqual([
      "credential", "credential-assignment", "internal-host", "personal-email",
    ]);
  });
});

describe("synthetic values stay clear and generic leaks are caught", () => {
  const policy = { bannedTerms: [], privatePatterns: [] };
  it("does not flag reserved documentation values", () => {
    const synthetic = [
      "203.0.113.42",
      "connect to https://api.example.invalid/v1",
      "/home/example/report.txt",
      "/Users/example/notes.md",
      "contact user@example.invalid",
      "00000000-0000-4000-8000-000000000042",
      "call-fixture-alpha",
    ].join("\n");
    expect(scanText(synthetic, policy)).toEqual([]);
  });

  it("catches generic credential, assignment and host shapes", () => {
    const token = fragments("ghp_", "x".repeat(40));
    expect(scanText(`token ${token}`, policy).map(f => f.kind)).toEqual(["credential"]);
    const assignment = fragments("password: '", "x".repeat(24), "'");
    expect(scanText(assignment, policy).map(f => f.kind)).toEqual(["credential-assignment"]);
    const host = fragments("db", ".", "lan", " reachable");
    expect(scanText(host, policy).map(f => f.kind)).toEqual(["internal-host"]);
  });

  it("normalizes obfuscated forms before matching", () => {
    expect(normalizeForScan('"al" + "pha"')).toBe('"alpha"');
    expect(normalizeForScan('"al" + \'pha\'')).toBe('"alpha"');
    expect(normalizeForScan('\'al\' + "pha"')).toBe('"alpha"');
    expect(normalizeForScan('"al" + \'pha\' + "bet"')).toBe('"alphabet"');
    expect(normalizeForScan("al[p]ha\\-be[t]a")).toBe("alpha-beta");
    expect(normalizeForScan("MiXeD CaSe")).toBe("mixed case");
  });

  it("detects an obfuscated secret through normalization, not raw matching", () => {
    const policyWithTerm = { bannedTerms: ["ghp_token"], privatePatterns: [] };
    const sq = String.fromCharCode(39); // apostrophe assembled at runtime
    const dq = String.fromCharCode(34);
    const obfuscated = [dq, "gh", dq, " + ", dq, "p_tok", dq, " + ", dq, "en", dq, " + ", dq, "d", dq].join("");
    expect(scanText(obfuscated, policyWithTerm).map(f => f.kind)).toEqual(["banned-term"]);
    const mixedQuote = [dq, "gh", dq, " + ", sq, "p_tok", sq, " + ", dq, "en", dq, " + ", sq, "d", sq].join("");
    expect(scanText(mixedQuote, policyWithTerm).map(f => f.kind)).toEqual(["banned-term"]);
  });
});
