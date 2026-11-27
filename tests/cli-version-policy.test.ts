import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertQualifiedVersions, qualifyMuseVersion, MIN_CLI_VERSION, TESTED_CLI_MAX } from "../src/cli-version.js";
afterEach(() => vi.restoreAllMocks());

it("documents the tested floor/ceiling, refuses older/unparseable clients and accepts the tested range", () => {
  expect(MIN_CLI_VERSION).toBe("1.4.14");
  expect(TESTED_CLI_MAX).toBe("1.4.25");
  for (const output of ["Muse Code 1.4.13", "Muse Code 1.3.99", "Muse Code 0.4.14", "garbage", "Muse Code 1.4.14garbage"])
    expect(() => assertQualifiedVersions(output, "1.4.14", {})).toThrow(/Unqualified/);
  expect(assertQualifiedVersions("Muse Code 1.4.14 (1.4.14-R7309.1)", "1.4.14", {})).toEqual({client:"1.4.14",sdk:"1.4.14"});
});

it("silently continues on newer versions with the independently pinned SDK; strict mode always refuses", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(assertQualifiedVersions("Muse Code 1.4.25 (1.4.25-R9361.1)", "1.4.14", {})).toEqual({client:"1.4.25",sdk:"1.4.14"});
  expect(warn).not.toHaveBeenCalled();
  for (const output of ["Muse Code 1.4.26 (1.4.26-R1.1)", "Muse Code 1.4.26"])
    expect(assertQualifiedVersions(output, "1.4.14", {})).toEqual({client:"1.4.26",sdk:"1.4.14"});
  expect(warn).not.toHaveBeenCalled();
  expect(() => assertQualifiedVersions("Muse Code 1.4.26", "1.4.14", {PI_MUSE_TETHER_STRICT_VERSION:"1"})).toThrow(/STRICT_VERSION/);
  expect(() => assertQualifiedVersions("Muse Code 1.4.26", "1.4.15", {})).toThrow(/SDK/);
  expect(warn).not.toHaveBeenCalled();
});

it("version admission does not gate ordinary turns by experimental build qualification", () => {
  for (const output of ["Muse Code 1.4.14 (1.4.14-R7309.1)", "Muse Code 1.4.15 (1.4.15-R8339.1)", "Muse Code 1.4.14", "Muse Code 1.4.14 (1.4.14-R7309.2)", "Muse Code 1.4.15", "Muse Code 1.4.15 (1.4.15-R8339.2)", "Muse Code 1.4.16 (1.4.16-R1.1)"])
    expect(() => assertQualifiedVersions(output, "1.4.14", {})).not.toThrow();
});

it("re-evaluates strict policy even after caching a newer selector probe, without running a real client", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const dir = await mkdtemp(join(tmpdir(), "muse-newer-version-policy-"));
  const binary = join(dir, "muse");
  await writeFile(binary, '#!/bin/sh\nprintf "Muse Code 1.4.27 (1.4.27-R1.1)\\n"\n', {mode:0o700});
  await writeFile(join(dir, ".muse-version"), "1.4.27-R1.1");
  await writeFile(join(dir, "muse-bin-1.4.27-R1.1"), "synthetic identity only");
  const env = {...process.env, PI_MUSE_TETHER_STRICT_VERSION:"0"};
  await qualifyMuseVersion(binary, env);
  await qualifyMuseVersion(binary, env);
  expect(warn).not.toHaveBeenCalled();
  await expect(qualifyMuseVersion(binary, {...env, PI_MUSE_TETHER_STRICT_VERSION:"1"})).rejects.toThrow(/STRICT_VERSION/);
});
