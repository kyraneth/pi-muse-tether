import { fixtureModel } from "./verification-offline-guard.js";
/** Native Pi1.5.0 entry fixture. Official SDK in-memory transport; no vendor model. */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { registerApiDispatch } from "pi-tether-core/register";
import { appendFile } from "node:fs/promises";
import { createMuseProvider } from "../src/provider.js";
import { openFixtureHost } from "./fixture-host.js";
import { flushMuseLedger } from "../src/request-ledger.js";
export default function (pi: any) {
  const base = getBuiltinModels("meta").find(
    (m) => m.id === "muse-spark-1.3-contributor",
  )!;
  const provider = createMuseProvider({
    openHost: async (options) => {
      const host = await openFixtureHost(options),
        submit = host.submitInput.bind(host);
      host.submitInput = async (input, effort) => {
        await appendFile(
          process.env.VERIFICATION_ENTRY_LOG!,
          JSON.stringify({
            piSessionId: options.piSessionId,
            effort,
            purpose: options.purpose ?? "coding",
            inputKinds:
              typeof input === "string" ? ["text"] : input.map((p) => p.type),
            imageCount:
              typeof input === "string"
                ? 0
                : input.filter((p) => p.type === "image").length,
          }) + "\n",
        );
        return submit(input, effort);
      };
      return host;
    },
  });
  registerApiDispatch("pi-muse-tether", provider.streamViaMuse);
  pi.registerProvider("pi-muse-tether", {
    api: "pi-muse-tether",
    apiKey: "unused",
    baseUrl: "pi-muse-tether",
    models: [fixtureModel(base)],
    streamSimple: provider.streamViaMuse,
  });
  pi.registerCommand("muse-doctor", {
    description: "offline fixture doctor",
    handler: async (_: any, ctx: any) =>
      ctx.ui.notify(
        "Verification offline fixture; no vendor account or inference",
        "info",
      ),
  });
  pi.on("session_start", async (_: any, ctx: any) => {
    await provider.retireAll();
    provider.setSessionManager(ctx.sessionManager, true);
  });
  pi.on("session_shutdown", async () => {
    await provider.retireAll();
    await flushMuseLedger();
  });
}
