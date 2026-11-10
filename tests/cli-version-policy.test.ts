import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertQualifiedVersions, qualifyMuseVersion, MIN_CLI_VERSION, TESTED_CLI_MAX } from "../src/cli-version.js";
afterEach(() => vi.restoreAllMocks());

it("documents the tested floor/ceiling, refuses older/unparseable clients and accepts the tested range", () => {
  expect(MIN_CLI_VERSION).toBe("1.4.14");
  expect(TESTED_CLI_MAX).toBe("1.4.15");
  for (const output of ["Muse Code 1.4.13", "Muse Code 1.3.99", "Muse Code 0.4.14", "garbage", "Muse Code 1.4.14garbage"])
    expect(() => assertQualifiedVersions(output, "1.4.14", false, {})).toThrow(/Unqualified/);
  expect(assertQualifiedVersions("Muse Code 1.4.14 (1.4.14-R7309.1)", "1.4.14", false, {})).toEqual({client:"1.4.14",sdk:"1.4.14"});
});

it("warns once per newer version per process and continues with the independently pinned SDK; strict mode always refuses", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(assertQualifiedVersions("Muse Code 1.4.15 (1.4.15-R8339.1)", "1.4.14", false, {})).toEqual({client:"1.4.15",sdk:"1.4.14"});
  expect(warn).not.toHaveBeenCalled(); // 1.4.15 is inside the tested range
  for (const output of ["Muse Code 1.4.17 (1.4.17-R1.1)", "Muse Code 1.4.17"])
    expect(assertQualifiedVersions(output, "1.4.14", false, {})).toEqual({client:"1.4.17",sdk:"1.4.14"});
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.lastCall![0]).toMatch(/not yet qualified/);
  expect(() => assertQualifiedVersions("Muse Code 1.4.17", "1.4.14", false, {PI_MUSE_TETHER_STRICT_VERSION:"1"})).toThrow(/STRICT_VERSION/);
  expect(() => assertQualifiedVersions("Muse Code 1.4.17", "1.4.15", false, {})).toThrow(/SDK/);
  expect(warn).toHaveBeenCalledTimes(1);
});

it("never loosens the experimental exact-build gate for a newer client, even outside strict mode", () => {
  for (const output of ["Muse Code 1.4.14 (1.4.14-R7309.1)", "Muse Code 1.4.15 (1.4.15-R8339.1)"])
    expect(() => assertQualifiedVersions(output, "1.4.14", true, {})).not.toThrow();
  for (const output of ["Muse Code 1.4.14", "Muse Code 1.4.14 (1.4.14-R7309.2)", "Muse Code 1.4.15", "Muse Code 1.4.15 (1.4.15-R8339.2)", "Muse Code 1.4.16 (1.4.16-R1.1)"])
    expect(() => assertQualifiedVersions(output, "1.4.14", true, {})).toThrow(/rawLog\/committed-batch/);
});

it("re-evaluates strict policy even after caching a newer selector probe, without running a real client", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const dir = await mkdtemp(join(tmpdir(), "muse-newer-version-policy-"));
  const binary = join(dir, "muse");
  await writeFile(binary, '#!/bin/sh\nprintf "Muse Code 1.4.16 (1.4.16-R1.1)\\n"\n', {mode:0o700});
  await writeFile(join(dir, ".muse-version"), "1.4.16-R1.1");
  await writeFile(join(dir, "muse-bin-1.4.16-R1.1"), "synthetic identity only");
  const env = {...process.env, PI_MUSE_TETHER_STRICT_VERSION:"0"};
  await qualifyMuseVersion(binary, env);
  await qualifyMuseVersion(binary, env);
  expect(warn).toHaveBeenCalledTimes(1);
  await expect(qualifyMuseVersion(binary, {...env, PI_MUSE_TETHER_STRICT_VERSION:"1"})).rejects.toThrow(/STRICT_VERSION/);
});
