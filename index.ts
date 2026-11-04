import { museCatalogModels } from "./src/catalog.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { registerApiDispatch } from "pi-tether-core/register";
import { streamViaMuse, retireAll, setSessionManager, rawCompletionQualified, committedCompaction } from "./src/provider.js";

import { discoverMuseCatalog } from "./src/host.js";
import { museDoctor } from "./src/doctor.js";
import { setQuotaListener, quotaStatusLine } from "./src/rate-limit.js";
import { setRetryStatusListener } from "./src/retry-status.js";
import { flushMuseLedger } from "./src/request-ledger.js";
const ID = "pi-muse-tether";

/** The echo catalog entry is a synthetic offline fixture, not Muse model metadata. */
export async function registerMuseExtension(pi: ExtensionAPI, provider = {streamViaMuse,retireAll,setSessionManager,rawCompletionQualified,committedCompaction}, echoCatalog?: {contextWindow:number;maxTokens:number}) {
  const {streamViaMuse,retireAll,setSessionManager,rawCompletionQualified,committedCompaction}=provider;
  const template = getBuiltinModels("anthropic")[0];
  if (!template)
    throw new Error("Pi supplied no catalog template for offline echo");
  const stream = streamViaMuse;
  const catalog = process.env.PI_MUSE_TETHER_LIVE === "1" ? await discoverMuseCatalog() : undefined;
  const liveModels = catalog ? museCatalogModels(catalog) : [];
  registerApiDispatch(ID, stream);
  pi.registerProvider(ID, {
    api: ID,
    apiKey: "unused",
    baseUrl: "pi-muse-tether",
    models: [
      ...liveModels,
      {
        id: "echo",
        name: "Muse echo (offline fixture)",
        reasoning: false,
        input: ["text"],
        contextWindow: echoCatalog?.contextWindow ?? template.contextWindow,
        maxTokens: echoCatalog?.maxTokens ?? template.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple: stream,
  });
  pi.registerCommand("muse-doctor", {description:"Local Muse version, recipe and telemetry diagnostic (no model/account request)",handler:async(_args,ctx)=>{ctx.ui.notify(await museDoctor(ctx.model?.id),"info");}});
  pi.on("session_start", async (_event, ctx) => {
    setQuotaListener(payload=>ctx.ui.setStatus("muse-rate-limit",quotaStatusLine(payload)));
    setRetryStatusListener(status=>ctx.ui.setStatus("muse-retry",status));
    await retireAll("session_start");
    // Print has no UI just like RPC; the command flag distinguishes one-shot.
    const print = process.argv.includes("-p") || process.argv.includes("--print");
    setSessionManager(ctx.sessionManager, !print && Boolean(ctx.sessionManager.getSessionFile()));
  });
  pi.on("session_before_compact", (_event, ctx) => {
    if (ctx.model?.provider !== ID || rawCompletionQualified(ctx.model)) return;
    ctx.ui.notify(
      "Muse compaction is unsupported; the branch remains unchanged.",
      "warning",
    );
    return { cancel: true };
  });
  pi.on("session_before_tree", (event, ctx) => {
    if (
      ctx.model?.provider !== ID || rawCompletionQualified(ctx.model) ||
      !event.preparation.userWantsSummary ||
      !event.preparation.entriesToSummarize.length
    )
      return;
    ctx.ui.notify(
      "Muse tree summarization is unsupported; the branch remains unchanged.",
      "warning",
    );
    return { cancel: true };
  });
  pi.on("cache_warming_decision", (_event, ctx) => {
    if (ctx.model?.provider === ID) return { action: "stop" as const };
  });
  pi.on("session_shutdown", async () => {
    await retireAll("session_shutdown");
    await flushMuseLedger();
    setQuotaListener(undefined);
  });
  // Only committed compaction invalidates the coding cache. Preparation or a
  // failed/cancelled auxiliary summary must leave it usable.
  pi.on("session_compact", async (event) => { await committedCompaction(event); });
  pi.on("session_tree", async () => {
    await retireAll("session_tree");
  });
  pi.on("model_select", async () => {
    await retireAll("model_select");
  });
}
export default async function(pi:ExtensionAPI) { return registerMuseExtension(pi); }
