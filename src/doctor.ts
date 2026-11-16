import { museModelRoute } from "./model-route.js";
import { assertLoginSafe } from "./settings.js";
import { clientStatus, resolveMuseBinary } from "./qualification-records.js";
import { museFeatureStatus } from "./features.js";
import { qualifyClient } from "./qualification.js";
import { qualifyMuseVersion, MIN_CLI_VERSION, TESTED_CLI_MAX, isNewerThanTestedCli, strictCliVersion } from "./cli-version.js";
import { museLedgerPath } from "./request-ledger.js";
import { MUSE_CACHE_POLICY } from "./cache-policy.js";
/** Local diagnostic only: --version, no account/auth contents, quota or inference. */
export async function museDoctor(modelId?: string, args = "") {
  const [command, ...arguments_] = args.trim().split(/\s+/);
  if (command === "qualify") {
    const builds=arguments_.filter(value=>!value.startsWith("--"));
    if (builds.length > 1 || arguments_.some(value=>value.startsWith("--") && value !== "--live")) throw new Error("Usage: /muse-doctor qualify [build] [--live]");
    return JSON.stringify(await qualifyClient(builds[0],arguments_.includes("--live"),modelId ? museModelRoute(modelId)?.modelId : undefined),null,2);
  }
  if (command && command !== "qualify") throw new Error("Unknown /muse-doctor command; use /muse-doctor or /muse-doctor qualify [build] [--live]");
  const binary = resolveMuseBinary();
  const { META_API_KEY: _, ...env } = process.env;
  try {
    assertLoginSafe();
    const versions = await qualifyMuseVersion(binary, {...env, MUSE_NO_AUTO_UPDATE:"1"});
    let status:unknown;
    try { status=clientStatus(); } catch (error) { status={unavailable:String(error)}; }
    return JSON.stringify(
      {
        ok: true,
        binary,
        clientStatus:status,
        features:museFeatureStatus(),
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
