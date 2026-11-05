import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
export const QUALIFIED_CLIENT = "1.4.14";
export const QUALIFIED_SDK = "1.4.14";
export function assertQualifiedVersions(clientOutput: string, sdk: string, rawLog = false) {
  const match = /^Muse Code (\d+\.\d+\.\d+)(?: \(\1-R[\d.]+\))?$/.exec(
    clientOutput.trim(),
  );
  // Experimental committed-batch payloads are qualified against this exact build.
  if (match?.[1] !== QUALIFIED_CLIENT || sdk !== QUALIFIED_SDK ||
      (rawLog && clientOutput.trim() !== "Muse Code 1.4.14 (1.4.14-R7309.1)"))
    throw new Error(
      `Unqualified Muse client/SDK: client=${clientOutput.trim()}, SDK=${sdk}; requires Muse Code ${QUALIFIED_CLIENT}, SDK ${QUALIFIED_SDK}. Private settings prompt delivery must be requalified before upgrade; no model request submitted.`,
    );
  return { client: match[1], sdk };
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
  rawLog = false,
) {
  const entry = createRequire(import.meta.url).resolve("@muse-code/sdk");
  const sdk = JSON.parse(
    await readFile(resolve(dirname(entry), "../../package.json"), "utf8"),
  ).version;
  signal?.throwIfAborted();
  const identity = await binaryIdentity(binary);
  signal?.throwIfAborted();
  const key = identity && JSON.stringify([identity, sdk, rawLog]);
  const cached = key && versionCache.get(key);
  if (cached) return assertQualifiedVersions(cached, sdk, rawLog);
  const { stdout } = await promisify(execFile)(binary, ["--version"], {
    env: { ...env, MUSE_NO_AUTO_UPDATE: "1" },
    signal,
  });
  const result = assertQualifiedVersions(stdout, sdk, rawLog);
  signal?.throwIfAborted();
  if (key && identity === await binaryIdentity(binary)) versionCache.set(key, stdout);
  return result;
}
