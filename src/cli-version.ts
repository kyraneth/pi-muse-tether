import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
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
  const { stdout } = await promisify(execFile)(binary, ["--version"], {
    env: { ...env, MUSE_NO_AUTO_UPDATE: "1" },
    signal,
  });
  return assertQualifiedVersions(stdout, sdk, rawLog);
}
