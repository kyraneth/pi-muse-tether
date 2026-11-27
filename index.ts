import { museCatalogAssessment, museCatalogModels } from "./src/catalog.js";
import { authoritativeCatalogue, catalogueIdentity, readCatalogue, saveCatalogue } from "./src/catalog-cache.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { registerApiDispatch } from "pi-tether-core/register";
import { streamViaMuse, retireAll, setSessionManager, rawCompletionQualified, committedCompaction } from "./src/provider.js";

import { discoverMuseCatalog } from "./src/host.js";
import { museDoctor } from "./src/doctor.js";
import { setQuotaListener, quotaStatusLine } from "./src/rate-limit.js";
import { setRetryStatusListener } from "./src/retry-status.js";
import { flushMuseLedger } from "./src/request-ledger.js";
import { Text } from "@earendil-works/pi-tui";
import {
  nativeSearchRequested, strictMuse, nativeSearchLabel, NATIVE_SEARCH_ENTRY, NATIVE_SEARCH_NOTICE, NATIVE_SEARCH_NOTICE_ENTRY,
  type NativeSearchEntry, type NativeSearchSurface,
} from "./src/native-search.js";
const ID = "pi-muse-tether";

/** The echo catalog entry is a synthetic offline fixture, not Muse model metadata. */
export async function registerMuseExtension(pi: ExtensionAPI, provider = {streamViaMuse,retireAll,setSessionManager,rawCompletionQualified,committedCompaction}, echoCatalog?: {contextWindow:number;maxTokens:number}) {
  const {streamViaMuse,retireAll,setSessionManager,rawCompletionQualified,committedCompaction}=provider;
  const template = getBuiltinModels("anthropic")[0];
  if (!template)
    throw new Error("Pi supplied no catalog template for offline echo");
  const stream = streamViaMuse;
  const live = () => process.env.PI_MUSE_TETHER_LIVE === "1";
  const echo = {
    id: "echo", name: "Muse echo (offline fixture)", reasoning:false, input:["text" as const],
    contextWindow: echoCatalog?.contextWindow ?? template.contextWindow,
    maxTokens: echoCatalog?.maxTokens ?? template.maxTokens,
    cost: {input:0, output:0, cacheRead:0, cacheWrite:0},
  };
  let identity: string | undefined;
  let raw: unknown;
  let diagnostic = "live disabled";
  let discoveryError: string | undefined;
  let notifyContext: ExtensionContext | undefined;
  const rows = () => [...(live() ? museCatalogModels(raw) : []), echo];
  const discoveryWarning = () => discoveryError === undefined || !live() || museCatalogModels(raw).length ? undefined :
    `[pi-muse-tether] Catalogue discovery failed: ${discoveryError}. ${diagnostic}; see /muse-doctor.`;
  const warnDiscovery = (ctx: ExtensionContext) => {
    const warning = discoveryWarning();
    if (warning) ctx.ui.notify(warning, "warning");
  };
  const discover = async (before: string | undefined, context?: RefreshModelsContext) => {
    const signal = context?.signal;
    let next: unknown, error: string | undefined;
    try {
      next = await discoverMuseCatalog(signal);
      if (!authoritativeCatalogue(next)) throw new Error(`Non-authoritative catalogue (${museCatalogAssessment(next).diagnostics.source ?? "unavailable"})`);
    } catch (cause) {
      signal?.throwIfAborted();
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const after = await catalogueIdentity();
    signal?.throwIfAborted();
    const update = () => {
      if (!live()) return;
      if (before !== after) error = "Client or login identity changed during discovery";
      discoveryError = error;
      if (error) {
        raw = after && after === identity ? raw : readCatalogue(after);
        diagnostic = raw ? "retaining stale picker metadata" : "no live picker metadata";
      } else {
        raw = next;
        diagnostic = "official catalogue";
        saveCatalogue(after, raw);
      }
      identity = after;
      if (error && notifyContext) warnDiscovery(notifyContext);
    };
    if (context) await context.publish({update});
    else update();
  };
  if (live()) {
    identity = await catalogueIdentity();
    raw = readCatalogue(identity);
    if (raw) diagnostic = "cached picker metadata; admission uses live inventory";
    else {
      await discover(identity);
      // --list-models never starts a session; print/RPC can also lack a UI.
      const warning = discoveryWarning();
      if (warning) console.warn(warning);
    }
  }
  registerApiDispatch(ID, stream);
  pi.registerProvider(ID, {
    api: ID, apiKey: "unused", baseUrl: ID, models: rows(), streamSimple: stream,
    async refreshModels(context) {
      if (context.allowNetwork && live()) await discover(await catalogueIdentity(), context);
      return rows();
    },
  });
  pi.registerCommand("muse-doctor", {description:"Muse client and qualification diagnostic; refresh, ledger, qualify [build] [--live]",handler:async(args,ctx)=>{
    if (args.split(/\s+/).includes("--live") && !await ctx.ui.confirm("Live Muse qualification", "Runs model requests (batch, private prompt, MCP, resume, image) in isolated state using your existing login. Proceed?")) return;
    try {
      const refresh = args.trim() === "refresh";
      if (refresh) {
        const result = await ctx.modelRegistry.refresh({providers:[ID], allowNetwork:true, force:true});
        const error = result.errors.get(ID);
        if (error) throw error;
      }
      const catalogue = { ...museCatalogAssessment(raw).diagnostics, status:diagnostic, error:discoveryError,
        live:live(), ...(!live() && {enable:"Set PI_MUSE_TETHER_LIVE=1 before starting Pi to discover live models."}) };
      ctx.ui.notify(JSON.stringify({...refresh ? {} : JSON.parse(await museDoctor(ctx.model?.id, args)), catalogue},null,2),"info");
    }
    catch(error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  }});
  const displayNativeSearch = nativeSearchRequested() && !strictMuse();
  if (displayNativeSearch) {
    pi.registerEntryRenderer(NATIVE_SEARCH_NOTICE_ENTRY, () => new Text(NATIVE_SEARCH_NOTICE, 1, 0));
    pi.registerEntryRenderer<NativeSearchEntry>(NATIVE_SEARCH_ENTRY, entry =>
      entry.data ? new Text(nativeSearchLabel(entry.data), 1, 0) : undefined);
  }
  pi.on("session_start", async (_event, ctx) => {
    notifyContext = ctx;
    warnDiscovery(ctx);
    const replayNotice = (stages: number) => {
      const message = `[pi-muse-tether] Replaying earlier conversation in ${stages} preparatory ${stages === 1 ? "stage" : "stages"} before this turn.`;
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.warn(message);
    };
    setQuotaListener(payload=>ctx.ui.setStatus("muse-rate-limit",quotaStatusLine(payload)));
    setRetryStatusListener(status=>ctx.ui.setStatus("muse-retry",status));
    await retireAll("session_start");
    // Print has no UI just like RPC; the command flag distinguishes one-shot.
    const print = process.argv.includes("-p") || process.argv.includes("--print");
    const canPark = !print && Boolean(ctx.sessionManager.getSessionFile());
    if (displayNativeSearch) {
      const sessionId = ctx.sessionManager.getSessionId();
      let announced = ctx.sessionManager.getEntries().some(entry => entry.type === "custom" &&
        entry.customType === NATIVE_SEARCH_NOTICE_ENTRY && (entry.data as {sessionId?: string} | undefined)?.sessionId === sessionId);
      const search: NativeSearchSurface = {
        announce() {
          if (announced) return;
          pi.appendEntry(NATIVE_SEARCH_NOTICE_ENTRY, {sessionId, message:NATIVE_SEARCH_NOTICE});
          announced = true;
          if (!ctx.hasUI) console.warn(NATIVE_SEARCH_NOTICE);
        },
        record(entry) {
          pi.appendEntry(NATIVE_SEARCH_ENTRY, entry);
          if (!ctx.hasUI) console.warn(nativeSearchLabel(entry));
        },
      };
      setSessionManager(ctx.sessionManager, canPark, search, replayNotice);
    } else setSessionManager(ctx.sessionManager, canPark, undefined, replayNotice);
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
    notifyContext = undefined;
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
