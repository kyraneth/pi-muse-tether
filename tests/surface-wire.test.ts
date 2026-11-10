import { museDoctor } from "../src/doctor.js";
import { flushMuseLedger, museLedgerPath } from "../src/request-ledger.js";
import { it, expect, vi, afterEach } from "vitest";
import { Connection } from "@muse-code/sdk";
import { MuseHost, openMuseHost } from "../src/host.js";
import { museEffort } from "../src/thinking-config.js";
import { setQuotaListener } from "../src/rate-limit.js";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
afterEach(() => {
  vi.unstubAllEnvs();
  setQuotaListener(undefined);
});
class Frames {
  values: any[] = [];
  waiters: any[] = [];
  push(f: any) {
    const r = { value: JSON.stringify(f) + "\n", done: false },
      next = this.waiters.shift();
    if (next) next(r);
    else this.values.push(r);
  }
  end() {
    const r = { done: true },
      next = this.waiters.shift();
    if (next) next(r);
    else this.values.push(r);
  }
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        Promise.resolve(
          this.values.shift() ??
            new Promise((resolve) => this.waiters.push(resolve)),
        ),
    };
  }
}
function fixture(exhausted = false) {
  const frames = new Frames(),
    writes: any[] = [],
    quota = {
      observedAtMs: 1,
      tier: "contributor",
      window: {
        usedPercent: exhausted ? 100 : 1,
        resetsAtMs: 2,
        windowDurationMins: 300,
      },
      weekly: { usedPercent: 2, resetsAtMs: 3 },
    };
  const transport: any = {
    incoming: frames,
    async write(s: string) {
      const f = JSON.parse(s);
      writes.push(f);
      let result: any = {};
      // Real 1.4.14 answers the 1.4.15 session-MCP inventory query methodNotFound.
      if (f.method === "mcpServer/readInventory") { frames.push({jsonrpc:"2.0",id:f.id,error:{code:-32601,message:"method not found",data:{kind:"methodNotFound",retryable:false}}}); return; }
      if (f.method === "session/start")
        result = { session: { sessionId: "surface-wire" }, viewCursor: "0" };
      if (f.method === "usage/read") result = { usage: quota };
      if (f.method === "turn/start") {
        result = {
          commandId: f.params.commandId,
          status: "accepted",
          disposition: "started",
          turnId: f.params.commandId,
        };
        frames.push({
          jsonrpc: "2.0",
          method: "turn/started",
          params: {
            sessionId: "surface-wire",
            commandId: f.params.commandId,
            turnId: f.params.commandId,
            sourceRange: {},
            viewCursor: "1",
          },
        });
      }
      frames.push({ jsonrpc: "2.0", id: f.id, result });
    },
    close() {
      frames.end();
    },
  };
  const connection = new Connection(transport),
    events: any[] = [];
  const host = new MuseHost(
    connection,
    {
      sessionDurability: "ephemeral",
      grantedCapabilities: ["sessionMcp"],
    } as any,
    {
      cwd: process.cwd(),
      tools: ["read"],
      promptMode: "none",
      echo: false,
      onEvent: (e) => events.push(e),
    },
  );
  return { host, writes, connection, events };
}
it("official SDK wire carries image and each explicit effort; no SDK/model replay", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
  vi.stubEnv("XDG_STATE_HOME", await mkdtemp(join(tmpdir(), "muse-verification-admission-")));
  const f = fixture(),
    quotas: any[] = [];
  setQuotaListener((p) => quotas.push(p));
  try {
    await f.host.open();
    for (const level of [
      undefined,
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      const parts: any = [
        { type: "text", text: "synthetic" },
        { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
      ];
      const admitted = await f.host.submitInput(parts, museEffort(level));
      const wire = f.writes.filter((x) => x.method === "turn/start").at(-1);
      expect(wire.params.input).toEqual(parts);
      expect(wire.params.reasoningEffort).toBe(level ?? "none");
      f.host.receive({
        method: "turn/completed",
        params: {
          sessionId: "surface-wire",
          turnId: admitted.turnId,
          terminal: "completed",
          viewCursor: "2",
          sourceRange: {},
        },
      });
    }
    expect(f.writes.filter((x) => x.method === "turn/start")).toHaveLength(7);
    expect(f.writes.filter((x) => x.method === "usage/read")).toHaveLength(7);
    await flushMuseLedger();
    const body = await readFile(museLedgerPath(), "utf8");
    const admissions = body.trim().split("\n").map(line => JSON.parse(line)).filter(r => r.type === "turn_admitted");
    expect(admissions.map(r => r.requestedEffort)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(admissions.every(r => r.disposition === "started" && r.images[0].bytes === 5 && r.images[0].sha256.length === 64)).toBe(true);
    expect(body).not.toContain("aW1hZ2U=");
    expect(body).not.toContain("base64Data");
    f.host.receive({
      method: "usage/changed",
      params: { observedAtMs: 9, window: { usedPercent: 99 } },
    });
    expect(quotas.at(-1).window.usedPercent).toBe(99);
  } finally {
    await f.host.close();
  }
});
it("quota exhaustion refuses before turn/start on real SDK transport", async () => {
  vi.stubEnv("PI_MUSE_TETHER_LIVE", "1");
  const f = fixture(true);
  try {
    await f.host.open();
    await expect(f.host.submitInput("never sent")).rejects.toThrow(
      /limit reached/,
    );
    expect(f.writes.some((x) => x.method === "turn/start")).toBe(false);
  } finally {
    await f.host.close();
  }
});
it("version gate prevents spawning serve for unqualified executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muse-verification-version-")),
    binary = join(dir, "muse"),
    log = join(dir, "argv");
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' \"$*\" >> '${log}'\nprintf 'Muse Code 1.4.13\\n'\n`,
    { mode: 0o700 },
  );
  await expect(
    openMuseHost({
      cwd: dir,
      tools: ["read"],
      promptMode: "none",
      echo: true,
      binary,
    }),
  ).rejects.toThrow(/Unqualified Muse/);
  expect((await readFile(log, "utf8")).trim()).toBe("--version");
});

it("doctor remains local and reports unqualified client clearly without credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muse-verification-doctor-")),
    binary = join(dir, "muse"),
    log = join(dir, "commands");
  vi.stubEnv("PI_MUSE_TETHER_BINARY", binary);
  vi.stubEnv("META_API_KEY", "SYNTHETIC-MUST-NOT-REACH-DOCTOR");
  const script = (version: string) =>
    `#!/bin/sh\nprintf '%s %s\\n' \"$*\" \"$\{META_API_KEY+SET}\" >> '${log}'\nprintf 'Muse Code ${version}\\n'\n`;
  await writeFile(binary, script("1.4.14"), { mode: 0o700 });
  const ok = JSON.parse(await museDoctor());
  expect(ok.ok).toBe(true);
  expect(ok.client).toBe("1.4.14");
  expect(ok.apiKeyForwarded).toBe(false);
  expect(ok.cache.ttlSeconds).toBeNull();
  await writeFile(binary, script("1.4.16"), { mode: 0o700 });
  const newer = JSON.parse(await museDoctor());
  expect(newer.ok).toBe(true);
  expect(newer.versionPolicy).toEqual({minimum:"1.4.14",testedMaximum:"1.4.15",newerThanTested:true,strict:false});
  vi.stubEnv("PI_MUSE_TETHER_STRICT_VERSION", "1");
  const failed = JSON.parse(await museDoctor());
  expect(failed.ok).toBe(false);
  expect(failed.error).toMatch(/STRICT_VERSION/);
  await writeFile(binary, script("1.4.13"), { mode: 0o700 });
  expect(JSON.parse(await museDoctor()).error).toMatch(/Unqualified/);
  const commands = await readFile(log, "utf8");
  expect(commands).toBe("--version \n--version \n--version \n--version \n");
  expect(commands).not.toContain("SET");
});
