import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("production ledger append guard (synthetic production target)", () => {
  it.each([
    ["live", "append('live');", 0],
    ["test", "append('test');", 1],
    ["proof", "append('proof');", 1],
    ["same guard run masquerading as live", "append('live', process.env.PI_MUSE_TETHER_TEST_RUN_ID);", 1],
    ["overwritten prefix", "fs.writeFileSync(path, JSON.stringify({origin:'live',data:'changed'})+'\\n');append('live');", 1],
    ["malformed tail", "fs.appendFileSync(path, '{bad JSON}\\n');", 1],
    ["missing initially", "append('live');", 0],
  ])("handles %s", (name, change, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "muse-guard-ledger-"));
    try {
      const path = join(dir, "requests.jsonl"), receipt = join(dir, "receipt.json");
      const prefix = JSON.stringify({origin:"live",data:"original 🙂"}) + "\n";
      if (name !== "missing initially") writeFileSync(path, prefix);
      const env = {...process.env, NODE_OPTIONS:"", HOME:dir, XDG_STATE_HOME:dir, XDG_DATA_HOME:dir,
        PI_MUSE_TETHER_LEDGER_PATH:path, PI_MUSE_TETHER_ISOLATION_RECEIPT:receipt};
      const result = spawnSync(process.execPath, ["scripts/test-guard.mjs", "--", process.execPath, "-e",
        "const fs=require('node:fs'), path=process.argv[1];" +
        "const append=(origin,testRunId)=>fs.appendFileSync(path,JSON.stringify({origin,testRunId})+'\\n');" +
        change, path], {env, encoding:"utf8"});
      expect(result.status, result.stdout + result.stderr).toBe(expected);
      const proof = JSON.parse(readFileSync(receipt, "utf8"));
      expect(proof.changed.includes(path)).toBe(Boolean(expected));
      if (name === "live") expect(readFileSync(path,"utf8")).toBe(prefix + '{"origin":"live"}\n');
    } finally { rmSync(dir, {recursive:true,force:true}); }
  });
});
