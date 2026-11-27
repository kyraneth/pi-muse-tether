import {
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { museEffort, thinkingFrame } from "./thinking-config.js";
import { assertToolResultVerifiable, toolResultReceipt, readStoredToolOutput } from "./tool-result-receipt.js";
import { museCurrentInput, museReplayInput } from "./image-input.js";
import { PI_SUMMARY_SYSTEM, planMuseTurns, summaryReplay } from "./turn-plan.js";
import type { PlanEpisode } from "./request-ledger.js";
import { currentUserStart } from "./history.js";
import { applyMuseUsage, museApiReference, NO_PRICE_TABLE, NO_USAGE, UNKNOWN_RATES } from "./usage.js";
import { randomUUID } from "node:crypto";
import { publishRetryStatus, publishRedactionStatus } from "./retry-status.js";
import { piContext } from "pi-tether-core/pi-context";
import { projectionHash, requestSignature, matchesPrefix } from "pi-tether-core/request";
import {
  assertPromptMode,
  type PromptMode,
} from "pi-tether-core/system-prompt";
import {
  createMcpBridge,
  type BridgeInvocation,
  type BridgeResult,
} from "pi-tether-core/mcp/bridge";
import { openMuseHost, type MuseHost, type MuseHostEvent } from "./host.js";
import { assertToolSchemasWithinEnumLimit } from "./tool-schema.js";
import type { MuseHostOptions } from "./host.js";
import { NATIVE_SEARCH_TOOL, nativeSearchRequested, strictMuse, nativeSearchRefusal, type NativeSearchSurface } from "./native-search.js";

import { isQualifiedMuseModel, museResponseIdentity, museModelRoute } from "./model-route.js";
export { isQualifiedMuseModel } from "./model-route.js";

/** Per logical Pi request: native ingress waits for acknowledged admission and
 * async observers before Pi normalization. Status 0 means non-HTTP, never 200.
 * Muse owns/folds its SDK state first; callbacks observe, not replace, events. */
function requestHooks(model:any,options:any,onError:(error:Error)=>void) {
  if(!options.onResponse && !options.onProviderStreamEvent)return {
    enqueue:(work:()=>void)=>work(),observe:(event:MuseHostEvent,consume:()=>void)=>{if(event.kind!=="admission-refused")consume();},
    admit:async(_acceptance:string)=>{},refusalResponse:()=>undefined,
  };
  let admitted=false,failed=false;
  let refusal: Extract<MuseHostEvent,{kind:"admission-refused"}> | undefined;
  let refusalObservation: Promise<void> | undefined;
  let tail=Promise.resolve();
  const waiting:Array<()=>Promise<void>|void>=[];
  const enqueue=(work:()=>Promise<void>|void)=>{
    if(failed)return;
    if(!admitted){waiting.push(work);return;}
    tail=tail.then(async()=>{if(!failed)await work();}).catch(error=>{
      if(!failed){failed=true;onError(error instanceof Error?error:new Error(String(error)));}
    });
  };
  return {
    enqueue,
    observe(event:MuseHostEvent,consume:()=>void) {
      if(event.kind==="admission-refused") {
        if(!admitted && !failed)refusal=event;
        failed=true;waiting.length=0;return;
      }
      // Fencing retires the binding immediately, independently of observation.
      if(event.kind==="fenced"){failed=true;waiting.length=0;consume();return;}
      enqueue(async()=>{
        await options.onProviderStreamEvent?.({transport:"official-muse-client",source:"muse-host",event:structuredClone(event)},model);
        if(failed)return;
        options.signal?.throwIfAborted();
        consume();
      });
    },
    refusalResponse() {
      if(!refusal || !options.onResponse)return;
      const status=refusal.httpStatus??0;
      // An observer cannot replace a native refusal, even if it throws or
      // aborts. Invoke it outside SDK ingress, after failure control has run.
      return refusalObservation ??= Promise.resolve().then(async()=>{
        await options.onResponse({status,headers:{"x-pi-tether-transport":"official-muse-client","x-pi-tether-response":"logical-refusal"}},model);
      }).catch(()=>undefined);
    },
    async admit(acceptance:string) {
      if(admitted || failed)return;
      await options.onResponse?.({status:0,headers:{"x-pi-tether-transport":"official-muse-client","x-pi-tether-response":"logical-admission","x-pi-tether-acceptance":acceptance}},model);
      options.signal?.throwIfAborted();
      admitted=true;
      for(const work of waiting.splice(0))enqueue(work);
    },
  };
}

/** Isolated instance for qualification fixtures; production uses the qualified default below. */
export function createMuseProvider(config: {
  openHost?: (options: MuseHostOptions) => Promise<MuseHost>;
  /** Test entry can supply a preselected replay plan without a billed large payload. */
  planTurns?: typeof planMuseTurns;
  promptModes?: PromptMode[];
  instructionMechanisms?: string[];
  promptMode?: PromptMode | ((model:any)=>PromptMode);
  rawCompletion?: boolean;
  /** Qualification fixtures may opt into the pinned experimental batch protocol. */
  toolBatches?: boolean;
  modelAllowed?: (model:any)=>boolean;
} = {}) {
const openHost = config.openHost ?? openMuseHost;

const capabilities = {
  promptModes: config.promptModes ?? ["none"] as PromptMode[],
  instructionMechanisms: config.instructionMechanisms ?? [] as string[],
};
const selectMode=(model:any):PromptMode => (process.env.PI_MUSE_TETHER_SYSTEM_PROMPT ?? (typeof config.promptMode === "function" ? config.promptMode(model) : config.promptMode) ?? "none") as PromptMode;
function rawCompletionQualified(model:any) {return selectMode(model)==="replace" && Boolean(config.rawCompletion && config.promptModes?.includes("replace") && capabilities.instructionMechanisms.length);}
let sessionManager: any;
let searchSurface: NativeSearchSurface | undefined;
let replayNotice: ((stages: number) => void) | undefined;
let parking = true;
let compactionPermit: { manager:any; boundary:string; hash:string; overflow:boolean } | undefined;
/** Only Pi's committed automatic compaction authorizes a fresh mid-turn import.
 * Use the actual latest boundary: Pi 1.5 may report an older entry when
 * repeated summaries are byte-identical. Never authorize from summary text. */
async function committedCompaction(event:any) {
  const manager=sessionManager;
  const boundary=manager?.getBranch?.().at(-1);
  const projected=boundary?.type === "compaction" && (event.reason === "threshold" || event.reason === "overflow" && event.willRetry)
    ? manager.buildSessionProjection?.().messages : undefined;
  // This is an explicit Pi-owned cut after a committed batch, not permission
  // to replay an earlier failed or aborted attempt.
  await retireAll("session_compact", Boolean(projected));
  if (!projected || sessionManager !== manager || manager.getBranch().at(-1)?.id !== boundary.id) return;
  compactionPermit={manager,boundary:boundary.id,hash:historyHash(piContext({messages:convertToLlm(projected)}).messages),overflow:event.reason==="overflow"};
}
function setSessionManager(manager: any, canPark = true, search?: NativeSearchSurface, onReplay?: (stages: number) => void) {
  sessionManager = manager;
  searchSurface = search;
  replayNotice = onReplay;
  parking = canPark;
}
type Episode = {
  stream: any;
  output: any;
  ended: boolean;
  detachAbort?: () => void;
  text: Map<string,{index?:number;closed?:boolean}>;
  thinking: Map<string,number>;
  hooks: ReturnType<typeof requestHooks>;
};
type Binding = {
  key: string;
  requestHash: string;
  bridge?: ReturnType<typeof createMcpBridge>;
  auxiliary: boolean;
  plan?: PlanEpisode;
  host?: MuseHost;
  messages: any[];
  messageHash: string;
  declarationsHash: string;
  signature: string;
  park: boolean;
  reservations: Map<
    string,
    {
      name: string;
      args: Record<string, unknown>;
      approvalId: string;
      requirement: string;
    }
  >;
  manager: any;
  abort: AbortController;
  pending: Map<string, { invocation: BridgeInvocation; callId: string; result?: BridgeResult; verified: boolean }>;
  batch?: string[];
  batchSpec?: Array<{callId:string;name:string;args:Record<string,unknown>;piCallId:string;verified?:boolean;nativeTimedOut?:boolean;nativeStart?:{itemId:string;turnId:string;recordedAt:string};journal?:{entryId:string;response:BridgeResult}}>; 
  tools: Array<{name:string;description:string;inputSchema:any}>;
  approvalHolds: Map<string,{approvalId:string;requirement:string;ready:boolean;promise:Promise<void>;resolve:()=>void;reject:(error:Error)=>void}>;
  steeringPending?: boolean;
  deferredTerminal?: any;
  receiptsDone?:()=>void;
  verifyingReceipt?: Promise<void>;
  batchSurfaced: boolean;
  turnSignal?: AbortSignal;
  detachTurnAbort?: () => void;
  episode?: Episode;
  buffered: any[];
  closed: boolean;
  closing?: Promise<unknown>;
  opening?: Promise<MuseHost>;
  usageIds: Set<string>;
};
const bindings = new Map<string, Binding>();
// Unknown submitted work is not an automatic retry opportunity. Pi may retry a
// rejected request, but the same user entry cannot silently be submitted again.
const retryBlocks=new Map<string,{hash:string;reason:string}>();
// Custom messages become users in LLM context, but are not new user authority
// to replay failed work. Prefer Pi's actual native user entry for the fence.
// Minimal fixture managers without native user entries use the whole user run,
// never just its last (possibly fixed extension-note) message.
const lastUserHash=(messages:any[],manager:any)=>{
  const entry=manager?.getBranch?.().filter((e:any)=>e.type==="message" && e.message?.role==="user").at(-1);
  if (typeof entry?.id === "string") return `entry:${entry.id}`;
  if(entry)return projectionHash(entry.message);
  let end=messages.length;
  while(end && messages[end-1].role!=="user")end--;
  return projectionHash(messages.slice(currentUserStart(messages.slice(0,end)),end));
};
// Pi appends these local timing/effort decorations AFTER provider completion.
// All remaining acknowledged bytes (including content/tool IDs) stay exact.
const historyHash = (messages: any[]) => projectionHash(messages.map(({ durationMs, thinkingLevel, ...message }) => message));
const canonical = (value: any): string =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
    : JSON.stringify(value);
function message(model: any): any {
  const liveRecipe = isQualifiedMuseModel(model.id);
  return {
    ...(liveRecipe ? {costSource: museApiReference(model.id)?.cost ? NO_USAGE : NO_PRICE_TABLE, costPartial: true} : {}),
    role: "assistant",
    content: [],
    api: "pi-muse-tether",
    provider: model.provider,
    model: model.id,
    ...museResponseIdentity(model.id),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: liveRecipe
        ? { ...UNKNOWN_RATES, total: null }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    usagePresence: {
      input: false,
      output: false,
      cacheRead: false,
      cacheWrite: false,
    },
    nativeUsage: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function textDelta(e: Episode, item: {index?:number}, delta: string) {
  if (!delta) return;
  if (item.index === undefined) {
    item.index=e.output.content.length;
    e.output.content.push({type:"text",text:""});
    e.stream.push({type:"text_start",contentIndex:item.index,partial:e.output});
  }
  e.output.content[item.index].text += delta;
  e.stream.push({type:"text_delta",contentIndex:item.index,delta,partial:e.output});
}
function endText(e: Episode, item: {index?:number;closed?:boolean}) {
  if (item.closed) return;
  item.closed=true;
  if (item.index !== undefined)
    e.stream.push({type:"text_end",contentIndex:item.index,content:e.output.content[item.index].text,partial:e.output});
}
function finishVisible(e: Episode) {
  for (const item of e.text.values()) endText(e,item);
  for (const [id,index] of e.thinking) if (index >= 0) {
    e.stream.push({type:"thinking_end",contentIndex:index,content:e.output.content[index].thinking,partial:e.output});
    e.thinking.set(id,-2);
  }
}
function translateVisible(e: Episode, frame: any) {
  const p=frame.params ?? {}, agent=p.item?.kind === "agentMessage" ? p.item : undefined;
  if (agent && (frame.method === "item/started" || frame.method === "item/completed")) {
    if (typeof agent.itemId !== "string") throw new Error("Muse text lacks native item identity");
    if (!e.text.has(agent.itemId)) e.text.set(agent.itemId,{});
    const item=e.text.get(agent.itemId)!;
    if (frame.method === "item/completed") {
      const before=item.index === undefined ? "" : e.output.content[item.index].text;
      if (typeof agent.text === "string") {
        if (!agent.text.startsWith(before) || (item.closed && agent.text !== before))
          throw new Error("Muse committed text differs from streamed item");
        if (!item.closed) textDelta(e,item,agent.text.slice(before.length));
      }
      endText(e,item);
    }
  } else if (frame.method === "item/delta" && (p.field === undefined || p.field === "text") && typeof p.delta === "string") {
    const item=e.text.get(p.itemId);
    if (item && !item.closed) textDelta(e,item,p.delta);
  }
  thinkingFrame(e.output,e.stream,frame,e.thinking);
}
async function closeBinding(b: Binding, cause?: string) {
  publishRetryStatus(b);
  if (b.closed) return b.closing;
  b.closed = true;
  if (cause && !b.auxiliary && (b.plan || b.host && b.host.retrySafe !== true) && (!b.episode?.ended || b.batch))
    retryBlocks.set(b.key, { hash: b.requestHash, reason: cause });
  // Retain ownership until cleanup really finishes. Mark the host closing
  // before releasing approval waiters or aborting startup.
  const closingHost = b.host?.close(cause === "Request aborted" ? "abort" : "close");
  void closingHost?.catch(() => undefined);
  b.abort.abort();
  b.detachTurnAbort?.();
  for (const hold of b.approvalHolds.values()) hold.reject(new Error("Muse approval hold: binding retired before delivery"));
  b.approvalHolds.clear();
  b.receiptsDone?.(); b.receiptsDone=undefined;
  const e=b.episode;
  if(e&&!e.ended){
    e.ended=true;e.detachAbort?.();finishVisible(e);
    if (b.auxiliary) e.output.content=[];
    e.output.stopReason="aborted";e.output.errorMessage=cause === "Request aborted" ? cause : "Muse binding retired";
    e.stream.push({type:"error",reason:"aborted",error:e.output});e.stream.end();
  }
  b.closing=Promise.resolve().then(async()=>{
    try {
      // Keep the MCP descriptor alive until the opening host settles.
      const closeHost = closingHost ?? (await b.opening?.catch(()=>undefined))?.close();
      await Promise.allSettled([closeHost, b.bridge?.retire()]);
    } finally {if(bindings.get(b.key)===b)bindings.delete(b.key);}
  });
  return b.closing;
}
async function retireAll(reason = "retireAll", committedCut = false) {
  compactionPermit=undefined;
  for (const b of bindings.values()) b.host?.ledger?.retire(reason);
  await Promise.allSettled([...bindings.values()].map(b=>closeBinding(b, committedCut ? undefined : reason)));
}
function fail(b: Binding, reason: string, definitelyUnsubmitted=false) {
  if (b.closed) return;
  if(!b.auxiliary && (b.plan || (!definitelyUnsubmitted && b.host?.retrySafe!==true)))retryBlocks.set(b.key,{hash:b.requestHash,reason});
  const e = b.episode;
  if (!definitelyUnsubmitted) b.host?.fence(reason);
  if (e && !e.ended) {
    e.ended = true;
    e.detachAbort?.();
    finishVisible(e);
    if (b.auxiliary) e.output.content=[]; // Do not expose an unverified summary as a result.
    e.output.stopReason = "error";
    e.output.errorMessage = reason;
    if (b.plan && !isContextOverflow(e.output) && isRetryableAssistantError(e.output)) {
      // Upstream retry language refers to a single native turn, not this
      // logical plan. Pi must not replay stages that may already have run.
      e.output.errorMessage = "Muse staged replay stopped after a native failure. No automatic replay; inspect the request ledger.";
    }
    const terminal = () => {
      e.stream.push({ type: "error", reason: e.output.stopReason, error: e.output });
      e.stream.end();
    };
    const observation = e.hooks.refusalResponse();
    if (observation) void observation.then(terminal);
    else terminal();
  }
  void closeBinding(b);
}
const sequentialCalls = new WeakMap<Binding, BridgeInvocation[]>();
const sequentialStarts = new WeakMap<Binding, Map<string,{itemId:string;turnId:string;recordedAt:string}>>();
function settleBatch(b:Binding) {
  if (b.batchSpec?.every(c=>c.verified || c.nativeTimedOut)) {
    b.batch=undefined; b.batchSpec=undefined; b.batchSurfaced=false;
    b.receiptsDone?.(); b.receiptsDone=undefined;
    const next = sequentialCalls.get(b)?.shift();
    if (next && !b.closed) surface(b, next);
  }
}
function terminalError(event:any, output:any) {
  const error=event.frame?.params?.error;
  const detail=[error?.message,event.frame?.params?.reason,error?.kind,event.lastRetryCause]
    .find((v):v is string=>typeof v==="string" && v.trim().length>0);
  // Only the vendor model terminal can enter Pi's context overflow route.
  if (typeof detail==="string" && isContextOverflow({...output,stopReason:"error",errorMessage:detail}))
    return `Muse context overflow: ${detail}`;
  const status=error?.httpStatus ?? error?.status ?? error?.statusCode ?? (event.status==="failed" ? event.lastRetryHttpStatus : undefined);
  return `Muse turn ended ${event.status}${typeof status==="number" ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`;
}
function emitFrame(b: Binding, event: any) {
  if (b.closed) return;
  if (event.kind === "degraded" && event.feature === "rawLog") {
    // An approval may already be waiting for a committed frame that was lost.
    // Let its exact, validated MCP invocation enter the sequential queue; never
    // wait for a Pi result whose tool has not been surfaced yet.
    for (const [callId,hold] of b.approvalHolds) if (!hold.ready) {
      hold.ready=true; hold.resolve();
      b.host?.ledger?.record("tool_approval_released",{callId,reason:"rawLog degradation; sequential MCP ownership"});
    }
    return;
  }
  if (
    event.kind === "frame" &&
    ["approval/request", "approval/requested", "approval/updated"].includes(
      event.frame.method,
    )
  ) {
    const p = event.frame.params ?? {};
    for (const [id, r] of b.reservations)
      if (
        r.approvalId === p.approvalId &&
        (canonical(p.currentRequirementId) !== r.requirement ||
          (p.rawArgs !== undefined &&
            canonical(JSON.parse(p.rawArgs)) !== canonical(r.args)))
      )
        b.reservations.delete(id);
  }
  // A host failure is lifecycle state, even while Pi owns a suspended tool.
  // Never park it in the next episode's frame buffer.
  if (event.kind === "fenced") { publishRetryStatus(b); fail(b,event.reason); return; }
  if (event.kind === "terminal") publishRetryStatus(b);
  if (event.kind === "frame" && ["turn/retryScheduled","turn/modelRetryScheduled"].includes(event.frame.method)) {
    publishRetryStatus(b,event.frame.params); return;
  }
  // A pending approval is an official async decision, not a suspended MCP call.
  // Native cancellation, abandonment or requirement changes invalidate its hold
  // immediately. They never authorize another execution or a synthetic receipt.
  if(b.approvalHolds.size && event.kind==="frame") {
    const {method,params:p={}}=event.frame;
    const hold=[...b.approvalHolds.values()].find(h=>h.approvalId===p.approvalId);
    if(method==="turn/completed" || method==="session/closed" ||
        hold && (method==="approval/resolved" && (!hold.ready || p.decision!=="approved") || method==="approval/updated" && canonical(p.currentRequirementId)!==hold.requirement)) {
      fail(b,`Muse approval hold: native ${method} before actual MCP result delivery; no replay`);return;
    }
    const item=p.item;
    if(method==="item/completed" && item?.kind==="toolCall" && b.approvalHolds.has(item.callId)) {
      fail(b,`Muse approval hold: native ${item.tool} ${item.callId} ended ${item.status} before actual MCP result delivery; no replay`);return;
    }
  }
  // A Muse client native tool deadline is lifecycle state for the one call,
  // not a fence for the whole turn. The client times out its own MCP
  // request (~300 s observed on the wire; the qualified MSP/session MCP
  // surface offers no deadline control) and continues with a timeout
  // result for that call while Pi may still be executing. Record the
  // divergence now and settle only this call; Pi's journaled result is
  // never replayed to Muse and the turn carries on.
  if(event.kind==="frame") {
    const {method,params:p={}}=event.frame,item=p.item;
    const spec=item?.kind==="toolCall" ? b.batchSpec?.find(c=>c.callId===item.callId && !c.verified && !c.nativeTimedOut) : undefined;
    if (!spec && method === "item/started" && item?.kind === "toolCall") {
      const reservation=b.reservations.get(item.callId);
      if (reservation && item.tool === `mcp__pi__${reservation.name}`) {
        const starts=sequentialStarts.get(b) ?? new Map();
        starts.set(item.callId,{itemId:item.itemId,turnId:item.turnId,recordedAt:item.recordedAt});
        sequentialStarts.set(b,starts);
      }
    }
    if(spec && (method==="item/started" || method==="item/completed" && item.status==="timedOut")) {
      try {
        if(item.tool!==spec.name || item.args!==undefined && canonical(JSON.parse(item.args))!==canonical(spec.args) ||
            spec.nativeStart && (item.itemId!==spec.nativeStart.itemId || item.turnId!==spec.nativeStart.turnId))
          throw new Error("native tool lifecycle identity differs from committed Pi spec");
        if(method==="item/started")spec.nativeStart={itemId:item.itemId,turnId:item.turnId,recordedAt:item.recordedAt};
        else {
          const elapsed=Date.parse(item.recordedAt)-Date.parse(spec.nativeStart?.recordedAt ?? "");
          const observed=Number.isFinite(elapsed) && elapsed>=0 ? ` (~${Math.round(elapsed/1000)*1000} ms native elapsed; ${elapsed} ms from native timestamps)` : " (native elapsed unavailable)";
          const reason=`Muse native tool timeout: ${spec.name} ${item.callId} timedOut${observed}; Pi execution/consumption diverged; no replay`;
          const pendingMcp=b.pending.has(item.callId);
          b.host?.ledger?.record("tool_execution_divergence",{callId:item.callId,tool:spec.name,status:item.status,sourceRange:p.sourceRange,nativeStart:spec.nativeStart,nativeCompletedAt:item.recordedAt,piResultJournaled:Boolean(spec.journal),pendingMcp,reason});
          spec.nativeTimedOut=true;
          b.pending.delete(item.callId);
          return;
        }
      } catch(error:any) {fail(b,`Muse native tool lifecycle: ${error.message}`);return;}
    }
  }
  // Readback is asynchronous; preserve frame order, especially terminal and the
  // next sequential batch receipt. Cancellation/fencing remains immediate.
  if (b.verifyingReceipt) { b.buffered.push(event); return; }
  const e = b.episode;
  if (!e || e.ended) {
    b.buffered.push(event);
    return;
  }
  if (event.kind === "terminal") {
    // A native terminal may arrive in the same ingress batch as the final
    // receipt. Do not publish success before Pi's extra user context is
    // confirmed by turn/steer. A completed target must fail loudly, not drop it.
    if (b.steeringPending && event.status === "completed") { b.deferredTerminal=event; return; }
    if (event.status !== "completed") {
      fail(b,terminalError(event,e.output));
      return;
    }
    if (b.pending.size || (b.batch && b.batchSpec?.some(c=>!c.verified && !c.nativeTimedOut))) {
      fail(b, "Muse result consumption is unverified");
      return;
    }
    // A batch fully settled by native tool timeouts needs no receipt to retire.
    if (b.batch) { b.batch=undefined; b.batchSpec=undefined; b.batchSurfaced=false; }
    finishVisible(e);
    if (!b.tools.length && (!e.output.content.some((part:any)=>part.type === "text" && part.text.trim()) ||
      !e.output.usagePresence.input || !e.output.usagePresence.output)) {
      fail(b,"Muse tool-free completion lacks verified text or native input/output usage");
      return;
    }
    const expectsStructured = b.tools.some((t) => t.name === "structured_output");
    const satisfiedStructured = b.messages.some(
      (m: any) => m?.role === "toolResult" && m.toolName === "structured_output" && !m.isError,
    );
    if (expectsStructured && !satisfiedStructured) {
      const textLength = e.output.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .reduce((sum: number, part: any) => sum + part.text.length, 0);
      b.host?.ledger?.record("structured_output_omitted", { textLength });
      fail(
        b,
        "Muse turn completed with plain text without calling declared structured_output; plain text preserved on the assistant message, no automatic resubmit",
      );
      return;
    }
    e.ended = true;
    e.detachAbort?.();
    b.messages.push(structuredClone(e.output));
    b.messageHash = historyHash(b.messages);
    b.host?.ledger?.endEpisode();
    const publish=()=>{e.stream.push({type:"done",reason:"stop",message:e.output});e.stream.end();};
    if(!b.park)void closeBinding(b).then(publish);else publish();
    return;
  }
  if (event.kind === "tool-batch") {
    if (!b.bridge) { fail(b,"Muse raw completion emitted tool/helper activity"); return; }
    // A predecessor batch fully settled (including by native timeouts) no
    // longer blocks Muse's next committed batch.
    if (b.batch && b.batchSpec?.every(c=>c.verified || c.nativeTimedOut)) settleBatch(b);
    if (b.batch || !event.calls.length || new Set(event.calls.map((x:any)=>x.callId)).size !== event.calls.length) {
      fail(b, "Muse duplicate or overlapping committed tool batch"); return;
    }
    // A committed spec is sufficient to schedule Pi; MCP invocations may be
    // sequential and need the first journaled result before the next exists.
    // Pi owns validation and coercion, including its normal error tool result.
    // Keep original model arguments immutable for native/MCP identity checks.
    b.batchSpec=event.calls.map((call:any)=>({...call,piCallId:b.pending.get(call.callId)?.invocation.piCallId ?? randomUUID()}));
    b.batch = event.calls.map((x:any)=>x.callId);
    for (const call of event.calls) {
      const pending=b.pending.get(call.callId);
      if(pending && (call.name !== `mcp__pi__${pending.invocation.name}` || canonical(call.args)!==canonical(pending.invocation.arguments))) {
        fail(b,"Muse committed tool batch differs from MCP invocation");return;
      }
    }
    settleBatch(b); flushTools(b); return;
  }
  if (event.kind !== "frame") return;
  const frame = event.frame,
    p = frame.params ?? {};
  try { translateVisible(e,frame); } catch(error:any) { fail(b,error.message); return; }
  if (frame.method === "session/tokenUsage" && p.usage) {
    const usageId = p.sourceRange?.last?.id ?? p.viewCursor;
    if (typeof usageId !== "string") {
      fail(b, "Muse usage has no unique native identity");
      return;
    }
    if (b.usageIds.has(usageId)) return;
    b.usageIds.add(usageId);
    try { applyMuseUsage(e.output,p); } catch(error:any) { fail(b,error.message); return; }
  }
  const item = p.item;
  if (
    frame.method === "item/completed" &&
    item?.kind === "toolCall" &&
    b.pending.get(item.callId)?.result
  ) {
    const pending = b.pending.get(item.callId)!;
    const r = pending.result!;
    const verify = (stored?: string) => {
      if (b.closed) return;
      if (item.tool !== `mcp__pi__${pending.invocation.name}` ||
          (item.args !== undefined && canonical(JSON.parse(item.args)) !== canonical(pending.invocation.arguments)))
        throw new Error("Muse tool result receipt invocation differs from pending MCP call");
      let redactions: import("./tool-result-receipt.js").VendorRedaction[] = [];
      let images: import("./tool-result-receipt.js").UnverifiableImage[] = [];
      let truncatedView: import("./tool-result-receipt.js").TruncatedView | undefined;
      const receipt = toolResultReceipt(item, r, stored, spans => { redactions = spans; }, declared => { images = declared; }, view => { truncatedView = view; });
      if (!b.bridge?.verifyContent(pending.invocation, receipt))
        throw new Error("Muse tool result mismatch");
      if (truncatedView) b.host?.ledger?.record("tool_result_truncated_view", {
        callId:item.callId, piToolCallId:b.batchSpec?.find(c=>c.callId===item.callId)?.piCallId ?? pending.invocation.piCallId, itemId:item.itemId,
        source:{tool:pending.invocation.name, piJournalEntryId:b.batchSpec?.find(c=>c.callId===item.callId)?.journal?.entryId},
        outputRefAvailability:item.outputRef?.availability ?? "absent", view:truncatedView,
        evidence:"declared-lossy-view", exactModelConsumption:false,
      });
      if (redactions.length) {
        b.host?.ledger?.record("tool_result_vendor_redaction", {
          callId: item.callId, piToolCallId: b.batchSpec?.find(c=>c.callId===item.callId)?.piCallId ?? pending.invocation.piCallId, itemId: item.itemId,
          source: {tool:pending.invocation.name, piJournalEntryId:b.batchSpec?.find(c=>c.callId===item.callId)?.journal?.entryId,
            ...(pending.invocation.name==="read" ? {path:pending.invocation.arguments.path} : {})}, count: redactions.length,
          rule: "positional-declared-loss-v4", spans: redactions, evidence:"declared-lossy",
          textProjection: r.isError ? "lf-joined-all-text-parts" : images.length ? "native-ordered-parts-with-image-metadata" : "native-text-chunk-fold",
          exactModelConsumption: false,
        });
        publishRedactionStatus(b, redactions.length);
      }
      if (images.length) b.host?.ledger?.record("tool_result_image_unverifiable", {
        callId: item.callId, piToolCallId: b.batchSpec?.find(c=>c.callId===item.callId)?.piCallId ?? pending.invocation.piCallId, itemId: item.itemId,
        source: {tool:pending.invocation.name, piJournalEntryId:b.batchSpec?.find(c=>c.callId===item.callId)?.journal?.entryId,
          ...(pending.invocation.name==="read" ? {path:pending.invocation.arguments.path} : {})},
        images:images.map(image=>({...image,modelVisibility:image.modelVisibility??"unproven"})), deliveredToMcp: true, evidence:"declared-lossy", unverifiableInContent: true,
        rule: "mcp-image-placeholder-v1", exactModelConsumption: false,
      });
      pending.verified = true;
      b.pending.delete(item.callId);
      const spec=b.batchSpec?.find(c=>c.callId===item.callId);
      if(spec)spec.verified=true;
      settleBatch(b);
    };
    if (item.outputRef && !(item.truncated === true && ["missing","unsupported","accessFailed"].includes(item.outputRef.availability))) {
      b.verifyingReceipt = readStoredToolOutput(item, offset => {
        if (!b.host?.readToolOutput) throw new Error("Muse host cannot read item/outputRef");
        return b.host.readToolOutput(item, offset);
      }).then(verify).catch(error => { if (!b.closed) fail(b, `Muse tool result receipt (call ${item.callId}, item ${item.itemId}): ${error.message}`); }).finally(() => {
        b.verifyingReceipt=undefined;
        const events=b.buffered.splice(0);
        for(const next of events)emitFrame(b,next);
      });
    } else {
      try { verify(); } catch(error:any) { fail(b, `Muse tool result receipt (call ${item.callId}, item ${item.itemId}): ${error.message}`); }
    }
  }
}
function attach(b: Binding, e: Episode, signal?: AbortSignal) {
  b.detachTurnAbort?.();
  b.episode = e;
  b.host?.ledger?.beginEpisode(b.batch ? "handoff" : "turn",b.plan);
  if (signal) {
    const abort = () => { void closeBinding(b, "Request aborted"); };
    signal.addEventListener("abort", abort, { once: true });
    e.detachAbort = () => signal.removeEventListener("abort", abort);
    b.detachTurnAbort=e.detachAbort;
    if (signal.aborted) {
      abort();
      return;
    }
  }
  const events = b.buffered.splice(0);
  // These frames were already observed while detached. Preserve that single
  // observation, but gate their normalization behind this request's response.
  for (const event of events) e.hooks.enqueue(() => emitFrame(b, event));
}
function surface(b: Binding, inv: BridgeInvocation) {
  if (b.closed) throw new Error("Muse binding retired before invocation");
  const callId = (inv.metadata as any)?.callId;
  const reservation =
    typeof callId === "string" ? b.reservations.get(callId) : undefined;
  if (
    !reservation ||
    reservation.name !== inv.name ||
    canonical(reservation.args) !== canonical(inv.arguments) ||
    b.pending.has(callId)
  ) {
    fail(b, "Muse MCP invocation does not match a one-shot approval");
    throw new Error("Unapproved MCP invocation");
  }
  if (b.host?.batches && !b.batchSpec) b.host.degradeBatches?.("rawLog batch boundary absent before MCP invocation");
  const committedSpec=b.batchSpec?.find(spec=>spec.callId===callId);
  if (!b.host?.batches && b.batch && !committedSpec) {
    const queue = sequentialCalls.get(b) ?? [];
    if (queue.some(previous => (previous.metadata as any)?.callId === callId)) {
      fail(b, "Duplicate queued Muse invocation"); throw new Error("Duplicate invocation");
    }
    queue.push(inv); sequentialCalls.set(b, queue); return;
  }
  b.reservations.delete(callId);
  b.approvalHolds.delete(callId); // Actual MCP invocation ends the approval handoff.
  if(b.batchSpec){
    const spec=b.batchSpec.find(c=>c.callId===callId);
    if(!spec||spec.name!==`mcp__pi__${inv.name}`||canonical(spec.args)!==canonical(inv.arguments)){
      fail(b,"Muse committed tool batch differs from MCP invocation");throw new Error("Tool batch mismatch");
    }
  }
  if(b.batchSpec?.find(c=>c.callId===callId)?.verified){fail(b,"Muse duplicate batch invocation");throw new Error("Duplicate invocation");}
  b.pending.set(callId, { invocation: inv, callId, verified: false });
  if ((!(config.toolBatches ?? true) || !b.host?.batches) && !b.batchSpec) {
    // A batch surfaced before degradation must finish under its existing spec.
    // Only genuinely new calls enter the sequential ownership path.
    if(b.pending.size!==1){fail(b,"Concurrent Muse tools require committed batch capability");throw new Error("Missing tool batch");}
    b.batch=[callId];
    b.batchSpec=[{callId,name:`mcp__pi__${inv.name}`,args:inv.arguments,piCallId:inv.piCallId,nativeStart:sequentialStarts.get(b)?.get(callId)}];
    sequentialStarts.get(b)?.delete(callId);
  }
  const spec=b.batchSpec?.find(c=>c.callId===callId);
  if(spec?.journal)deliverResult(b,spec);
  flushTools(b);
}
function deliverResult(b:Binding,spec:NonNullable<Binding["batchSpec"]>[number]) {
  const pending=b.pending.get(spec.callId);
  if(!pending || !spec.journal || pending.result || b.closed)return;
  pending.result=spec.journal.response;
  b.bridge!.journalResult({...pending.invocation,journalEntryId:spec.journal.entryId,result:spec.journal.response});
}
function flushTools(b: Binding) {
  const e=b.episode;
  if (!b.batch || b.batchSurfaced || !b.batchSpec) return;
  if (!e || e.ended) {fail(b,"Pi episode detached during committed MCP batch");return;}
  const executable=b.batchSpec;
  b.batchSurfaced=true;
  finishVisible(e);
  for(const spec of executable) {
  const toolCall = {
    type: "toolCall",
    id: spec.piCallId,
    name: spec.name.slice("mcp__pi__".length),
    arguments: spec.args,
  };
  const index = e.output.content.length;
  e.output.content.push(toolCall);
  e.output.stopReason = "toolUse";
  e.stream.push({
    type: "toolcall_start",
    contentIndex: index,
    partial: e.output,
  });
  e.stream.push({
    type: "toolcall_end",
    contentIndex: index,
    toolCall,
    partial: e.output,
  });
  }
  e.ended = true;
  // Keep the turn signal attached while Pi executes tools / shows approval.
  b.host?.ledger?.endEpisode();
  e.stream.push({ type: "done", reason: "toolUse", message: e.output });
  e.stream.end();
}
/** Live inference is explicit opt-in; echo always launches the offline provider. */
function streamEffective(model: any, input: any, options: any = {}) {
  if(config.modelAllowed && !config.modelAllowed(model)){
    const refused=createAssistantMessageEventStream();const output=message(model);output.stopReason="error";output.errorMessage="Muse model is not qualified for Pi prompt/compaction; select a catalogue-registered Muse route";
    refused.push({type:"error",reason:"error",error:output});refused.end();return refused;
  }
  const context = piContext(input);
  const requestedMode = selectMode(model);
  const toolFree = context.tools.length === 0;
  if (toolFree && !rawCompletionQualified(model)) {
    const refused=createAssistantMessageEventStream();const output=message(model);
    output.stopReason="error";output.errorMessage="Muse raw completion and compaction are unsupported: prompt delivery unqualified";
    refused.push({type:"error",reason:"error",error:output});refused.end();return refused;
  }
  const manager = sessionManager;
  const owner = String(manager?.getSessionId?.() ?? "");
  const current = bindings.get(owner);
  // Tool availability is not a lifetime signal. Only an exact projection of
  // the active journal can park an empty-tool host. Auxiliary requests never
  // acquire or mutate its binding, even when Pi reuses its routing string.
  let journalChat = false;
  if (toolFree && context.systemPrompt !== PI_SUMMARY_SYSTEM && parking && owner && options.sessionId === owner && options.cacheRetention !== "none" &&
      manager?.getSessionFile?.() && context.messages.at(-1)?.role === "user" &&
      (!current || current.closed || (current.episode?.ended && !current.batch))) {
    const native = manager.getBranch?.().at(-1);
    const projected = manager.buildSessionProjection?.().messages;
    journalChat = Boolean(projected && (native?.message?.role === "user" || native?.type === "custom_message") &&
      historyHash(piContext({messages:convertToLlm(projected)}).messages) === historyHash(context.messages));
  }
  const auxiliary = toolFree && !journalChat;
  const owningManager = auxiliary ? undefined : manager;
  const searchEnabled = !auxiliary && model.id !== "echo" && nativeSearchRequested();
  const search = searchEnabled ? searchSurface : undefined;
  const key = auxiliary ? `auxiliary:${randomUUID()}` : String(options.sessionId ?? owner);
  const stream = createAssistantMessageEventStream();
  const output = message(model);
  const episode: Episode = { stream, output, ended: false, text:new Map(), thinking:new Map(), hooks: requestHooks(model,options,error=>{
    if(binding)fail(binding,error.message);
    else {output.stopReason="error";output.errorMessage=error.message;stream.push({type:"error",reason:"error",error:output});stream.end();}
  }) };
  let binding: Binding | undefined;
  void (async () => {
    let b: Binding | undefined;
    try {
      museEffort(options.reasoning); // reject unknown tiers before host work
      const permit=auxiliary ? undefined : compactionPermit;
      if (!auxiliary) compactionPermit=undefined; // one Pi coding attempt, never a retry ticket
      const compactedContinuation=Boolean(permit && permit.manager===manager &&
        manager?.getBranch?.().at(-1)?.id===permit.boundary &&
        historyHash(context.messages)===permit.hash);
      if (compactedContinuation && permit!.overflow && retryBlocks.get(key)?.reason.startsWith("Muse context overflow:")) retryBlocks.delete(key);
      const blocked=retryBlocks.get(key);
      if(blocked && (blocked.hash===lastUserHash(context.messages,owningManager) || context.messages.at(-1)?.role==="toolResult"))throw new Error((blocked.reason.startsWith("Muse native tool timeout:") || blocked.reason.startsWith("Muse approval hold:")) ? `${blocked.reason}; no automatic resubmit. Submit a new user request explicitly.` : "Muse prior request failed; no automatic resubmit. Submit a new user request explicitly.");
      // A genuinely new user request ends the old failure fence. Otherwise that
      // stale fence would incorrectly block this new request's later tool batch.
      if(blocked && context.messages.at(-1)?.role==="user")retryBlocks.delete(key);
      const mode = requestedMode;
      assertPromptMode(capabilities, mode as PromptMode);
      if (searchEnabled && (!search || mode !== "replace"))
        throw new Error("Muse native search requires a Pi session display and private prompt replacement; no prompt was sent.");
      if (model.id !== "echo" && process.env.PI_MUSE_TETHER_LIVE !== "1")
        throw new Error("Live Muse requires explicit PI_MUSE_TETHER_LIVE=1");
      if (!auxiliary && (!owner || key !== owner))
        throw new Error(
          "Pi session identity is required and must match the active journal",
        );
      const tools = context.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      }));
      // Refuse schemas over the provider's 3,000-enum cap locally before
      // touching any binding or spawning a host; nothing was submitted.
      assertToolSchemasWithinEnumLimit(tools);
      const declarationHash = projectionHash(tools);
      const route = museModelRoute(model.id);
      const signature = requestSignature([model.id, route?.contributorMode, context.systemPrompt, tools, mode, process.cwd(),
        ...(search ? ["native:client-web-search"] : [])]);
      b = bindings.get(key);
      if(b?.closed){await closeBinding(b);b=undefined;}
      if (options.signal?.aborted) {
        if (b && b.batch) {
          b.episode = episode;
          await closeBinding(b, "Request aborted");
          return;
        }
        throw new Error("Request aborted");
      }
      if (b && (
        b.manager !== owningManager || b.signature !== signature ||
        b.declarationsHash !== declarationHash ||
        !matchesPrefix(context.messages, { length: b.messages.length, hash: b.messageHash }, historyHash) ||
        (!b.batch && (context.messages.length <= b.messages.length || !context.messages.slice(b.messages.length).every((m:any)=>m.role === "user")))
      )) {
        // Only a NEW user request may reimport. Unknown mid-turn work is never replayed.
        if (b.batch || context.messages.at(-1)?.role !== "user")
          throw new Error("Muse binding changed during unfinished work; no automatic recovery");
        await closeBinding(b);
        b = undefined;
      }
      if (b) {
        binding = b;
        b.episode = episode;
        if (!b.batch) {
          const delta = context.messages.slice(b.messages.length);
          if (!delta.length || !delta.every((m:any)=>m.role === "user"))
            throw new Error("Muse completed-turn continuation requires an exact append of user messages");
          const text = museCurrentInput(delta);
          episode.hooks.enqueue(()=>stream.push({type:"start",partial:output}));
          attach(b, episode, options.signal);
          if (b.closed) return;
          b.messages = structuredClone(context.messages);
          b.requestHash=lastUserHash(context.messages,owningManager);
          b.messageHash = historyHash(b.messages);
          await b.host!.submitInput(text, options.reasoning);
          await episode.hooks.admit("turn/start");
          return;
        }
        const pendingBatch=b.batchSpec!;
        if (pendingBatch.some(p=>p.journal)) throw new Error("Muse pending result already supplied");
        const delta = context.messages.slice(b.messages.length),
          assistant = delta[0],
          results = delta.slice(1).filter((x:any)=>x.role==="toolResult"),
          steering = delta.slice(1).filter((x:any)=>x.role==="user");
        const calls =
          assistant?.content?.filter((x: any) => x.type === "toolCall") ?? [];
        if (
          assistant?.role !== "assistant" ||
          calls.length !== pendingBatch.length || results.length !== pendingBatch.length ||
          delta.length !== 1+results.length+steering.length ||
          !delta.slice(1,1+results.length).every((m:any)=>m.role==="toolResult") ||
          !delta.slice(1+results.length).every((m:any)=>m.role==="user") ||
          pendingBatch.some((p,i)=>calls[i].id!==p.piCallId || `mcp__pi__${calls[i].name}`!==p.name || canonical(calls[i].arguments)!==canonical(p.args)) ||
          new Set(results.map((r:any)=>r.toolCallId)).size!==results.length
        )
          throw new Error("Muse continuation is not the pending Pi result");
        // Validate the complete Pi batch before delivering ANY result. Results
        // always attach to suspended MCP requests, never turn/steer.
        const journaled = pendingBatch.map(pending=>{
        const result=results.find((r:any)=>r.toolCallId===pending.piCallId);
        if(!result || `mcp__pi__${result.toolName}`!==pending.name)throw new Error("Muse continuation is not the pending Pi result");
        const entry = b.manager
          ?.getBranch?.()
          .filter(
            (x: any) =>
              x.type === "message" &&
              x.message?.role === "toolResult" &&
              x.message.toolCallId === result.toolCallId,
          )
          .at(-1);
        if (
          !entry ||
          `mcp__pi__${entry.message.toolName}` !== pending.name ||
          canonical(entry.message.content) !== canonical(result.content) ||
          Boolean(entry.message.isError) !== Boolean(result.isError)
        )
          throw new Error("Pi journaled result unavailable or mismatch");
        const response: BridgeResult = {
          content: result.content,
          isError: result.isError === true,
        };
        // Reject unqualified rich layouts before delivering ANY batch response.
        // Captured LF text projection and [text, PNG] placeholder are checked
        // at the native receipt; image content remains explicitly unverifiable.
        // A natively timed-out call is excluded from delivery; its Pi result
        // is never delivered to Muse, so the layout gate does not apply.
        if(!pending.nativeTimedOut)assertToolResultVerifiable(response);
        return {pending,entry,response};
        });
        episode.hooks.enqueue(()=>stream.push({type:"start",partial:output}));
        attach(b, episode, options.signal);
        if (b.closed) return;
        b.messages = structuredClone(context.messages);
        b.requestHash=lastUserHash(context.messages,owningManager);
        b.messageHash = historyHash(context.messages);
        // The native suspended MCP request already exists. A response hook may
        // refuse its continuation before any journaled result is delivered.
        await episode.hooks.admit("suspended-mcp-continuation");
        if(b.closed)return;
        b.steeringPending=steering.length>0;
        const consumed=steering.length?new Promise<void>(resolve=>{b!.receiptsDone=resolve;}):undefined;
        for(const {pending,entry,response} of journaled){
          if(pending.nativeTimedOut){
            // Muse already consumed the native timeout for this call (the
            // departed MCP request is never revived). Pi keeps its real result
            // in the journal; the divergence is declared, not replayed.
            b.host?.ledger?.record("tool_native_timeout_consumed",{callId:pending.callId,piToolCallId:pending.piCallId,tool:pending.name,piJournalEntryId:entry.id,deliveredToMcp:false,modelConsumedNative:"timedOut",exactModelConsumption:false,evidence:"declared-lossy"});
            continue;
          }
          pending.journal={entryId:entry.id,response};
          const hold=b.approvalHolds.get(pending.callId);
          if(hold) {
            hold.ready=true;
            b.host?.ledger?.record("tool_approval_released",{callId:pending.callId,approvalId:hold.approvalId,piJournalEntryId:entry.id,reason:"Pi result journaled; allow native MCP invocation"});
            hold.resolve();
          }
          deliverResult(b,pending);
        }
        if(consumed)await consumed;
        if(b.closed)return;
        // One ordered input, not competing native steering operations. Tool
        // receipts remain mandatory and never travel through turn/steer.
        if(steering.length) await b.host!.steerInput(museCurrentInput(steering));
        b.steeringPending=false;
        const terminal=b.deferredTerminal;b.deferredTerminal=undefined;
        if(terminal)emitFrame(b,terminal);
        return;
      }
      const projection=summaryReplay(museReplayInput(context.messages,compactedContinuation),context.systemPrompt,auxiliary);
      const reservations = new Map<
        string,
        {
          name: string;
          args: Record<string, unknown>;
          approvalId: string;
          requirement: string;
        }
      >();
      let candidate!: Binding;
      const bridge = toolFree ? undefined : createMcpBridge({
        sessionId: key,
        generation: randomUUID(),
        argumentValidation: "pi",
        tools,
        onInvocation: (inv) => candidate.episode!.hooks.enqueue(()=>surface(candidate, inv)),
      });
      candidate = {
        key,
        requestHash:lastUserHash(context.messages,owningManager),
        bridge, auxiliary,
        messages: structuredClone(context.messages),
        messageHash: historyHash(context.messages),
        declarationsHash: declarationHash,
        signature,
        park: !auxiliary && parking && Boolean(manager?.getSessionFile?.()),
        reservations,
        tools,
        approvalHolds:new Map(),
        buffered: [],
        closed: false,
        usageIds: new Set(),
        pending: new Map(), batchSurfaced:false,
        manager: owningManager,
        abort: new AbortController(),
      };
      b = candidate;
      binding = b;
      bindings.set(key, b);
      episode.hooks.enqueue(()=>stream.push({type:"start",partial:output}));
      attach(b, episode, options.signal);
      if (b.closed) return;
      const descriptor = await bridge?.start();
      if (b.closed) return;
      const host = await (b.opening=openHost({
        cwd: process.cwd(),
        piSessionId: auxiliary ? undefined : key,
        ...(toolFree ? {purpose:"raw" as const} : {}),
        ...(search ? {nativeSearch:true} : {}),
        tools: tools.map((t: any) => t.name),
        promptMode: mode as PromptMode,
        ...(mode === "replace" ? {privatePrompt:{systemPrompt:context.systemPrompt}} : {}),
        echo: model.id === "echo",
        toolBatches: !toolFree && (config.toolBatches ?? model.id !== "echo"),
        model: model.id === "echo" ? undefined : route?.modelId ?? model.id,
        contributorMode: route?.contributorMode ?? "on",
        pickerModel: model.id,
        signal: b.abort.signal,
        mcpServers: descriptor ? { pi: { transport: "stdio", ...descriptor } } : {},
        ...(descriptor ? {waitForToolReceipt: () => candidate.verifyingReceipt ? (async()=>{
          while(candidate.verifyingReceipt)await candidate.verifyingReceipt;
        })() : undefined,
        waitForPiToolResult: (request:any) => {
          // The no-batch compatibility path learns its spec only from MCP and
          // cannot hold before that invocation. Qualified live hosts use rawLog.
          if(!candidate.host?.batches)return;
          if(candidate.closed)throw new Error("Muse approval hold: retired binding");
          const callId=request.toolCallId,spec=candidate.batchSpec?.find(c=>c.callId===callId);
          const requirement=canonical(request.currentRequirementId),previous=candidate.approvalHolds.get(callId);
          if(previous) {
            if(previous.approvalId!==request.approvalId || previous.requirement!==requirement) {
              fail(candidate,"Muse approval hold: conflicting native approval identity; no replay");
              throw new Error("Conflicting held approval");
            }
            return previous.ready ? undefined : previous.promise;
          }
          if(spec?.journal) {
            candidate.approvalHolds.set(callId,{approvalId:request.approvalId,requirement,ready:true,promise:Promise.resolve(),resolve(){},reject(){}});
            candidate.host.ledger?.record("tool_approval_released",{callId,approvalId:request.approvalId,piJournalEntryId:spec.journal.entryId,reason:"Pi result already journaled; allow native MCP invocation"});
            return;
          }
          let resolve!:()=>void,reject!:(error:Error)=>void;
          const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
          candidate.approvalHolds.set(callId,{approvalId:request.approvalId,requirement,ready:false,promise,resolve,reject});
          candidate.host.ledger?.record("tool_approval_held",{callId,approvalId:request.approvalId,requirementId:request.currentRequirementId,tool:request.toolName,reason:"wait for journaled Pi result before native tools/call"});
          return promise;
        },
        validateApproval: (request: any) => {
          const name = String(request.toolName).slice("mcp__pi__".length),
            tool = tools.find((t: any) => t.name === name);
          if (!tool || !request.toolCallId) return false;
          try {
            const args = JSON.parse(request.rawArgs);
            const spec=candidate.batchSpec?.find(c=>c.callId===request.toolCallId);
            if(candidate.closed || (spec && (spec.verified || spec.name!==request.toolName || canonical(spec.args)!==canonical(args))) || (candidate.host?.batches && candidate.batchSpec && !spec))return false;
            const previous = reservations.get(request.toolCallId);
            if (
              previous &&
              (previous.name !== name ||
                canonical(previous.args) !== canonical(args))
            )
              return false;
            reservations.set(request.toolCallId, {
              name,
              args,
              approvalId: request.approvalId,
              requirement: canonical(request.currentRequirementId),
            });
            return true;
          } catch {
            return false;
          }
        }} : {}),
        onEvent: event => candidate.episode!.hooks.observe(event, () => {
          if (event.kind === "native-search") {
            if (!candidate.closed && search && searchSurface === search && sessionManager === manager) search.record(event.entry);
            return;
          }
          const item = search && event.kind === "frame" ? event.frame.params?.item as Record<string, unknown> | undefined : undefined;
          if (item?.kind === "toolCall" && item.tool === NATIVE_SEARCH_TOOL) return; // Never enter Pi receipt processing.
          emitFrame(candidate, event);
        }),
      }));
      b.host = host;
      if (b.closed) return; // The binding owner awaits and closes the opening host.
      b.abort.signal.throwIfAborted();
      const plan=(config.planTurns ?? planMuseTurns)(projection,host.measureTurn(options.reasoning));
      if (plan.stages.length) {
        if (search) throw new Error("Muse staged replay requires native search to be off; no stage was submitted.");
        b.park=false; // A staged native session exists only for this logical request.
        const id=randomUUID(),turns=plan.stages.length+1;
        bridge?.setAttached(false);
        for (const [i,input] of plan.stages.entries()) {
          b.plan={id,phase:"stage",index:i+1,turns};
          host.ledger?.beginEpisode(i===0 ? "spawn" : "turn",b.plan);
          const terminal=await host.submitStage(input,options.reasoning,i===0 ? () => {
            if (sessionManager === manager) replayNotice?.(plan.stages.length);
          } : undefined);
          host.ledger?.record("replay_stage_terminal",{status:terminal.status});
          host.ledger?.endEpisode();
          if (terminal.status!=="completed") throw new Error(terminalError(terminal,output));
          b.abort.signal.throwIfAborted();
        }
        b.plan={id,phase:"final",index:turns,turns};
        bridge?.setAttached(true); // Only after the last acknowledged matching terminal.
      }
      search?.announce();
      host.ledger?.beginEpisode(plan.stages.length ? "turn" : "spawn",b.plan);
      await host.submitInput(plan.final, options.reasoning);
      await episode.hooks.admit("turn/start");
    } catch (error: any) {
      const reason = b?.host?.fencedReason ?? String(error?.message || error);
      if (b) { b.episode = episode; fail(b, reason, error?.code === "MUSE_FRAME_TOO_LARGE" && !b.plan); }
      else {
        episode.ended = true;
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = reason;
        stream.push({
          type: "error",
          reason: output.stopReason,
          error: output,
        });
        stream.end();
      }
    }
  })();
  return stream;
}
function streamViaMuse(model:any,input:any,options:any={}) {
  const stream=createAssistantMessageEventStream();
  void (async()=>{
    try {
      if (model.id !== "echo" && nativeSearchRequested() && strictMuse()) throw new Error(nativeSearchRefusal);
      // Expose the logical official-client request, not an invented HTTP body.
      const payload={...structuredClone(piContext(input)),transport:"official-muse-client"};
      if(payload.tools.length) {
        payload.tools[0].description+=`\n\nTransport notice: the official-client transcript view of a tool result may be truncated; full model consumption cannot be inferred from that view. [REDACTED] in tool text can be official-client redaction; original bytes in those spans are unavailable. Literal [REDACTED] may already be source text: a marker alone does not prove loss. The client may canonicalize bearer to Bearer immediately before a redaction. Tool images are delivered without pixel attestation; GIF/WebP visibility is unqualified. Images attached to failed tool results are omitted by the official client.`;
      }
      const replacement=await options.onPayload?.(payload,model);
      const effective=replacement===undefined?payload:replacement;
      if(!effective || typeof effective!=="object" || !Array.isArray(effective.messages) || !Array.isArray(effective.tools) || typeof effective.systemPrompt!=="string")
        throw new Error("Muse onPayload must return a logical request with systemPrompt, messages and tools");
      if(effective.messages.some((entry:any)=>entry?.role==="system"))
        throw new Error("Muse logical payload messages exclude system messages; edit logical systemPrompt and tools instead");
      const names=new Set<string>();
      for(const tool of effective.tools) {
        if(typeof tool?.name!=="string" || !/^[A-Za-z0-9_-]+$/.test(tool.name) || names.has(tool.name) ||
          typeof tool.description!=="string" || !tool.parameters || typeof tool.parameters!=="object" || Array.isArray(tool.parameters))
          throw new Error("Muse logical payload tools require distinct exact names, descriptions and parameter schemas");
        names.add(tool.name);
      }
      for await(const event of streamEffective(model,effective,options))stream.push(event);
      stream.end();
    } catch(error:any) {
      const output=message(model);output.stopReason=options.signal?.aborted?"aborted":"error";output.errorMessage=String(error?.message??error);
      stream.push({type:"error",reason:output.stopReason,error:output});stream.end();
    }
  })();
  return stream;
}
return {streamViaMuse,setSessionManager,retireAll,rawCompletionQualified,committedCompaction};
}
// Qualified against official Muse 1.4.14: private settings + explicit
// session/start workspaceRoot place exact Pi bytes in provider instructions.
const defaultProvider=createMuseProvider({promptModes:["none","replace"],promptMode:(model)=>isQualifiedMuseModel(model.id)?"replace":"none",instructionMechanisms:["private-xdg-settings"],rawCompletion:true,modelAllowed:(model)=>model.id==="echo"||isQualifiedMuseModel(model.id)});
export const {streamViaMuse,setSessionManager,retireAll,committedCompaction}=defaultProvider;
export const rawCompletionQualified=defaultProvider.rawCompletionQualified;
