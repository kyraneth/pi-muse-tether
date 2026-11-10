import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { qualifyMuseVersion } from "../src/cli-version.js";

it("caches successful version probes only for the unchanged launcher, selector, active binary and rawLog qualification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muse-version-cache-"));
  const launcher = join(dir, "muse"), selector = join(dir, ".muse-version"), log = join(dir, "calls");
  const a = join(dir, "muse-bin-1.4.14-R7309.1"), b = join(dir, "muse-bin-1.4.14-R7309.2");
  await writeFile(launcher, '#!/bin/sh\necho x >> "$PROBE_LOG"\nprintf "Muse Code 1.4.14 (1.4.14-R7309.1)\\n"\n');
  await chmod(launcher, 0o755); await writeFile(a,"first"); await writeFile(b,"second");
  await writeFile(selector,"1.4.14-R7309.1\n");
  const env = {...process.env, PROBE_LOG:log};
  const count = async () => (await readFile(log,"utf8")).trim().split("\n").length;
  await qualifyMuseVersion(launcher,env); await qualifyMuseVersion(launcher,env); expect(await count()).toBe(1);
  await qualifyMuseVersion(launcher,env,undefined,true); expect(await count()).toBe(2);
  await writeFile(selector,"1.4.14-R7309.2\n"); await qualifyMuseVersion(launcher,env); expect(await count()).toBe(3);
  await writeFile(b,"changed active bytes"); await qualifyMuseVersion(launcher,env); expect(await count()).toBe(4);
  await writeFile(launcher, '#!/bin/sh\necho x >> "$PROBE_LOG"\nprintf "Muse Code 1.4.13\\n"\n');
  await expect(qualifyMuseVersion(launcher,env)).rejects.toThrow(/Unqualified/);
  await expect(qualifyMuseVersion(launcher,env)).rejects.toThrow(/Unqualified/);
  expect(await count()).toBe(6);
});
