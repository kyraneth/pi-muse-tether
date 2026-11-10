import { museModelRoute } from "./model-route.js";
import { assertLoginSafe } from "./settings.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { qualifyMuseVersion, MIN_CLI_VERSION, TESTED_CLI_MAX, isNewerThanTestedCli, strictCliVersion } from "./cli-version.js";
import { museLedgerPath } from "./request-ledger.js";
import { MUSE_CACHE_POLICY } from "./cache-policy.js";
/** Local diagnostic only: --version, no account/auth contents, quota or inference. */
export async function museDoctor(modelId?: string) {
  const binary =
    process.env.PI_MUSE_TETHER_BINARY ?? join(homedir(), ".local/bin/muse");
  const { META_API_KEY: _, ...env } = process.env;
  try {
    assertLoginSafe();
    const versions = await qualifyMuseVersion(binary, env);
    return JSON.stringify(
      {
        ok: true,
        binary,
        ...versions,
        versionPolicy: {minimum:MIN_CLI_VERSION, testedMaximum:TESTED_CLI_MAX, newerThanTested:isNewerThanTestedCli(versions.client), strict:strictCliVersion()},
        contributorMode: modelId ? museModelRoute(modelId)?.contributorMode ?? null : null,
        apiKeyForwarded: false,
        promptRecipe: "private-xdg-settings;private-trusted-workspaceRoot",
        ledger: museLedgerPath(),
        cache: MUSE_CACHE_POLICY,
        quota:
          "native usage/read before each turn; usage/changed status; doctor does not contact account",
        liveParity: "unproven;run serialized root proof",
      },
      null,
      2,
    );
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: e.message }, null, 2);
  }
}
