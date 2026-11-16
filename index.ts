import { museCatalogAssessment, museCatalogModels } from "./src/catalog.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { registerApiDispatch } from "pi-tether-core/register";
import { streamViaMuse, retireAll, setSessionManager, rawCompletionQualified, committedCompaction } from "./src/provider.js";

import { discoverMuseCatalog } from "./src/host.js";
import { featureNotice } from "./src/features.js";
import { clientStatus, clientBuildLabel } from "./src/qualification-records.js";
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
  const discover = async () => {
    if (process.env.PI_MUSE_TETHER_LIVE !== "1")
      return {models: [], diagnostics: {status: "live disabled"}};
    try {
      const catalog = await discoverMuseCatalog();
      return {models: museCatalogModels(catalog), diagnostics: museCatalogAssessment(catalog).diagnostics};
    } catch (error) {
      return {models: [], diagnostics: {status: "discovery failed", error: error instanceof Error ? error.message : String(error)}};
    }
  };
  let catalogue = await discover();
  registerApiDispatch(ID, stream);
  const registerProvider = () => pi.registerProvider(ID, {
    api: ID,
    apiKey: "unused",
    baseUrl: "pi-muse-tether",
    models: [
      ...catalogue.models,
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
  registerProvider();
  // Lifecycle refresh, not a timer or inference request. Also compare metadata:
  // changed limits/efforts must reach Pi even when the IDs have not changed.
  const modelShape = (models: typeof catalogue.models) =>
    JSON.stringify([...models].sort((a, b) => a.id.localeCompare(b.id)));
  pi.on("agent_end", async () => {
    const next = await discover();
    const changed = modelShape(next.models) !== modelShape(catalogue.models);
    catalogue = next;
    if (changed) registerProvider();
  });
  pi.registerCommand("muse-doctor", {description:"Muse client and qualification diagnostic; qualify [build] [--live]",handler:async(args,ctx)=>{
    if (args.split(/\s+/).includes("--live") && !await ctx.ui.confirm("Live Muse qualification", "Runs model requests (batch, private prompt, MCP, resume, image) in isolated state using your existing login. Proceed?")) return;
    try { ctx.ui.notify(JSON.stringify({...JSON.parse(await museDoctor(ctx.model?.id, args)),catalogue:catalogue.diagnostics},null,2),"info"); }
    catch(error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  }});
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_MUSE_TETHER_LIVE !== "1") ctx.ui.notify(featureNotice(clientBuildLabel(),"catalogue","PI_MUSE_TETHER_LIVE is unset","empty live catalogue; set PI_MUSE_TETHER_LIVE=1 to enable official discovery"),"warning");
    if (process.env.PI_MUSE_TETHER_LIVE === "1") {
      try { const status=clientStatus(false); ctx.ui.notify(`[pi-muse-tether] ${JSON.stringify(status)}; vendor updates are governed by capability/schema checks.`, "info"); }
      catch(error) { ctx.ui.notify(String(error), "error"); }
    }
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
