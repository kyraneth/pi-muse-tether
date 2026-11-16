import { qualifiedBatchBuilds } from "./qualification-records.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
/** Oldest client with the tested private-XDG prompt/isolation controls. */
export const MIN_CLI_VERSION = "1.4.14";
/** Raise only after qualification; newer clients are not thereby qualified. */
export const TESTED_CLI_MAX = "1.4.15";
/** Exact builds whose experimental rawLog committed-batch boundary was live
 * qualified: 1.4.14-R7309.1 (original), 1.4.15-R8339.1 (2026-11-10: parallel
 * two-call batch, private prompt, session MCP readiness, Ember). */
export const QUALIFIED_BATCH_BUILDS = () => qualifiedBatchBuilds();
/** The tether's SDK is pinned independently, not required to equal the CLI. */
export const QUALIFIED_SDK = "1.4.14";
const warnedNewerCliVersions = new Set<string>();
const compareVersions = (a: string, b: string) => {
  const right = b.split(".").map(Number);
  for (const [i, value] of a.split(".").map(Number).entries()) {
    if (value !== right[i]) return value > right[i] ? 1 : -1;
  }
  return 0;
};
export const isNewerThanTestedCli = (version: string) => compareVersions(version, TESTED_CLI_MAX) > 0;
export const strictCliVersion = (env: NodeJS.ProcessEnv = process.env) => env.PI_MUSE_TETHER_STRICT_VERSION === "1";

export function assertQualifiedVersions(clientOutput: string, sdk: string, env: NodeJS.ProcessEnv = process.env) {
  const match = /^Muse Code (\d+\.\d+\.\d+)(?: \(\1-R[\d.]+\))?$/.exec(clientOutput.trim());
  if (!match || compareVersions(match[1], MIN_CLI_VERSION) < 0 || sdk !== QUALIFIED_SDK)
    throw new Error(`Unqualified Muse client/SDK: client=${clientOutput.trim()}, SDK=${sdk}; requires Muse Code >=${MIN_CLI_VERSION}, SDK ${QUALIFIED_SDK}; no model request submitted.`);
  // Experimental capability is negotiated and its frames checked at runtime.
  // Qualification records report evidence; they do not deny unknown builds.
  if (isNewerThanTestedCli(match[1])) {
    if (strictCliVersion(env)) throw new Error(`Unqualified Muse Code ${match[1]}: PI_MUSE_TETHER_STRICT_VERSION=1 refuses newer than tested ${TESTED_CLI_MAX}; no model request submitted.`);
    if (!warnedNewerCliVersions.has(match[1])) {
      warnedNewerCliVersions.add(match[1]);
      console.warn(`[pi-muse-tether] Muse Code ${match[1]}: continuing, not yet qualified; capability/schema checks govern batching. PI_MUSE_TETHER_STRICT_VERSION=1 opts into refusing newer builds.`);
    }
  }
  return {client: match[1], sdk};
}
// Cache only the known official selector layout. Unknown launchers may delegate
// according to arbitrary state, so their version is probed for every host.
const versionCache = new Map<string, string>();
async function binaryIdentity(binary: string): Promise<string | undefined> {
  try {
    const path = await realpath(binary);
    if (path.split("/").at(-1) !== "muse") return undefined;
    const dir = dirname(path), selector = (await readFile(resolve(dir, ".muse-version"), "utf8")).trim();
    if (!/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(selector)) return undefined;
    const active = await realpath(resolve(dir, `muse-bin-${selector}`));
    const fingerprint = async (name: string) => { const s = await stat(name, {bigint:true}); return [name, String(s.dev), String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)]; };
    return JSON.stringify([await fingerprint(path), selector, await fingerprint(active)]);
  } catch { return undefined; }
}
export async function qualifyMuseVersion(
  binary: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  const entry = createRequire(import.meta.url).resolve("@muse-code/sdk");
  const sdk = JSON.parse(
    await readFile(resolve(dirname(entry), "../../package.json"), "utf8"),
  ).version;
  signal?.throwIfAborted();
  const identity = await binaryIdentity(binary);
  signal?.throwIfAborted();
  const key = identity && JSON.stringify([identity, sdk]);
  const cached = key && versionCache.get(key);
  if (cached) return assertQualifiedVersions(cached, sdk, env);
  const { stdout } = await promisify(execFile)(binary, ["--version"], {
    env,
    signal,
  });
  const result = assertQualifiedVersions(stdout, sdk, env);
  signal?.throwIfAborted();
  if (key && identity === await binaryIdentity(binary)) versionCache.set(key, stdout);
  return result;
}

