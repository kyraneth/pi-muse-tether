import {
  createAssistantMessageEventStream,
  validateToolArguments,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { museEffort, thinkingFrame } from "./thinking-config.js";
import { assertToolResultVerifiable, toolResultReceipt, readStoredToolOutput } from "./tool-result-receipt.js";
import { museCurrentInput, museHistoryInput } from "./image-input.js";
import { currentUserStart } from "./history.js";
import { applyMuseUsage, museModelCost } from "./usage.js";
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
import { openMuseHost, type MuseHost } from "./host.js";
import { streamRawCompletion } from "./raw-completion.js";
import type { MuseHostOptions } from "./host.js";

import { isQualifiedMuseModel, museResponseIdentity, museModelRoute } from "./model-route.js";
export { isQualifiedMuseModel } from "./model-route.js";

/** Isolated instance for qualification fixtures; production uses the qualified default below. */
export function createMuseProvider(config: {
  openHost?: (options: MuseHostOptions) => Promise<MuseHost>;
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
let parking = true;
let compactionPermit: { manager:any; boundary:string; hash:string; overflow:boolean } | undefined;
/** Only Pi's committed automatic compaction authorizes a fresh mid-turn import.
 * Use the actual latest boundary: Pi 1.5 may report an older entry when
 * repeated summaries are byte-identical. Never authorize from summary text. */
async function committedCompaction(event:any) {
  await retireAll("session_compact");
  const boundary=sessionManager?.getBranch?.().at(-1);
  if (boundary?.type !== "compaction" || !["threshold","overflow"].includes(event.reason)) return;
  if (event.reason === "overflow" && !event.willRetry) return;
  const projected=sessionManager?.buildSessionProjection?.().messages;
  if (!projected) return;
  compactionPermit={manager:sessionManager,boundary:boundary.id,hash:historyHash(piContext({messages:convertToLlm(projected)}).messages),overflow:event.reason==="overflow"};
}
function setSessionManager(manager: any, canPark = true) {
  sessionManager = manager;
  parking = canPark;
}
type Episode = {
  stream: any;
  output: any;
  ended: boolean;
  textIndex?: number;
  detachAbort?: () => void;
  thinking?: Map<string,number>;
};
type Binding = {
  key: string;
  requestHash: string;
  bridge: ReturnType<typeof createMcpBridge>;
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
  batchSpec?: Array<{callId:string;name:string;args:Record<string,unknown>;piCallId:string;nativeOnly?:boolean;verified?:boolean;nativeStart?:{itemId:string;turnId:string;recordedAt:string};journal?:{entryId:string;response:BridgeResult}}>;
  tools: Array<{name:string;description:string;inputSchema:any}>;
  schemaRefusals: Map<string,{name:string;args:Record<string,unknown>;approvalId:string;sessionId:string;turnId:string;settled:boolean}>;
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
const lastUserHash=(messages:any[])=>{
  const entry=sessionManager?.getBranch?.().filter((e:any)=>e.type==="message" && e.message?.role==="user").at(-1);
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
  const unknownPrice = isQualifiedMuseModel(model.id) && museModelCost(model.id).input === null;
  return {
    ...(unknownPrice ? {costSource:"unknown:no-applicable-price-table;not-subscription-billing",costPartial:true} : {}),
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
      cost: unknownPrice
        ? { input: null, output: null, cacheRead: null, cacheWrite: null, total: null }
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
async function closeBinding(b: Binding) {
  publishRetryStatus(b);
  if (b.closed) return b.closing;
  b.closed = true;
  // Retain ownership until cleanup really finishes. Otherwise session_shutdown
  // can miss a fenced binding whose asynchronous close is still in flight.
  b.closing=Promise.resolve().then(async()=>{
    b.detachTurnAbort?.();
    for(const hold of b.approvalHolds.values())hold.reject(new Error("Muse approval hold: binding retired before delivery"));
    b.approvalHolds.clear();
    b.receiptsDone?.(); b.receiptsDone=undefined;
    b.abort.abort();
    const e=b.episode;
    if(e&&!e.ended){
      e.ended=true;e.detachAbort?.();e.output.stopReason="aborted";e.output.errorMessage="Muse binding retired";
      e.stream.push({type:"error",reason:"aborted",error:e.output});e.stream.end();
    }
    try {
      const opened=b.host??await b.opening?.catch(()=>undefined);
      await Promise.allSettled([opened?.close(),b.bridge.retire()]);
    }
    finally {if(bindings.get(b.key)===b)bindings.delete(b.key);}
  });
  return b.closing;
}
async function retireAll(reason = "retireAll") {
  compactionPermit=undefined;
  for (const b of bindings.values()) b.host?.ledger?.retire(reason);
  await Promise.allSettled([...bindings.values()].map(closeBinding));
}
function fail(b: Binding, reason: string) {
  if(b.host?.retrySafe!==true)retryBlocks.set(b.key,{hash:b.requestHash,reason});
  const e = b.episode;
  b.host?.fence(reason);
  if (e && !e.ended) {
    e.ended = true;
    e.detachAbort?.();
    const aborted = reason === "Request aborted";
    e.output.stopReason = aborted ? "aborted" : "error";
    e.output.errorMessage = reason;
    e.stream.push({
      type: "error",
      reason: e.output.stopReason,
      error: e.output,
    });
    e.stream.end();
  }
  void closeBinding(b);
}
function validArguments(tool: Binding["tools"][number] | undefined, callId:string, args:Record<string,unknown>): boolean {
  if (!tool) return false;
  try {
    const checked=validateToolArguments({name:tool.name,description:tool.description ?? "",parameters:tool.inputSchema} as any,
      {type:"toolCall",id:callId,name:tool.name,arguments:args as any});
    return canonical(args)===canonical(checked);
  } catch { return false; }
}
function settleBatch(b:Binding) {
  if (b.batchSpec?.every(c=>c.verified)) {
    b.batch=undefined; b.batchSpec=undefined; b.batchSurfaced=false;
    b.receiptsDone?.(); b.receiptsDone=undefined;
  }
}
function emitFrame(b: Binding, event: any) {
  if (b.closed) return;
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
  // Native tool termination is lifecycle state, not an ordinary future receipt.
  // Muse can time out its MCP request while Pi is still executing the tool.
  // Never defer that divergence until Pi returns, or accept the next batch.
  if(event.kind==="frame") {
    const {method,params:p={}}=event.frame,item=p.item;
    const spec=item?.kind==="toolCall" ? b.batchSpec?.find(c=>c.callId===item.callId && !c.nativeOnly && !c.verified) : undefined;
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
          b.host?.ledger?.record("tool_execution_divergence",{callId:item.callId,tool:spec.name,status:item.status,sourceRange:p.sourceRange,nativeStart:spec.nativeStart,nativeCompletedAt:item.recordedAt,piResultJournaled:Boolean(spec.journal),pendingMcp:b.pending.has(item.callId),reason});
          fail(b,reason);return;
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
      const detail = event.frame?.params?.error?.message;
      // Preserve Pi's native overflow entry path without introducing a new
      // generic retry policy or replaying an uncertain host request.
      const overflow = typeof detail === "string" && isContextOverflow({...e.output,stopReason:"error",errorMessage:detail});
      const error = event.frame?.params?.error;
      const status = error?.httpStatus ?? error?.status ?? error?.statusCode ?? (event.status === "failed" ? event.lastRetryHttpStatus : undefined);
      fail(b, overflow ? `Muse context overflow: ${detail}` : `Muse turn ended ${event.status}${typeof status === "number" ? ` (HTTP ${status})` : ""}${typeof detail === "string" ? `: ${detail}` : ""}`);
      return;
    }
    if (b.pending.size || b.batch) {
      fail(b, "Muse result consumption is unverified");
      return;
    }
    if (e.textIndex !== undefined)
      e.stream.push({
        type: "text_end",
        contentIndex: e.textIndex,
        content: e.output.content[e.textIndex].text,
        partial: e.output,
      });
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
    if (b.batch || !event.calls.length || new Set(event.calls.map((x:any)=>x.callId)).size !== event.calls.length) {
      fail(b, "Muse duplicate or overlapping committed tool batch"); return;
    }
    // A committed spec is sufficient to schedule Pi; MCP invocations may be
    // sequential and need the first journaled result before the next exists.
    if(event.calls.some((call:any)=>{
      const refusal=b.schemaRefusals.get(call.callId);
      return refusal && (refusal.name!==call.name || canonical(refusal.args)!==canonical(call.args));
    })) {fail(b,"Muse schema refusal differs from committed tool batch");return;}
    b.batchSpec=event.calls.map((call:any)=>{
      const nativeOnly=!validArguments(b.tools.find(t=>call.name===`mcp__pi__${t.name}`),call.callId,call.args);
      const refusal=b.schemaRefusals.get(call.callId);
      return {...call,piCallId:b.pending.get(call.callId)?.invocation.piCallId ?? randomUUID(),nativeOnly,verified:nativeOnly && refusal?.settled===true};
    });
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
  thinkingFrame(e.output,e.stream,frame,e.thinking??=new Map());
  if (
    frame.method === "item/delta" &&
    p.field === "text" &&
    typeof p.delta === "string"
  ) {
    if (e.textIndex === undefined) {
      e.textIndex = e.output.content.length;
      e.output.content.push({ type: "text", text: "" });
      e.stream.push({
        type: "text_start",
        contentIndex: e.textIndex,
        partial: e.output,
      });
    }
    e.output.content[e.textIndex].text += p.delta;
    e.stream.push({
      type: "text_delta",
      contentIndex: e.textIndex,
      delta: p.delta,
      partial: e.output,
    });
  }
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
  const refusal=item?.kind==="toolCall" ? b.schemaRefusals.get(item.callId) : undefined;
  if(frame.method==="item/completed" && refusal) {
    // This tool never crossed MCP: the public SDK approval handler refused its
    // schema. Only the matching native rejection, not a synthetic Pi result,
    // can settle it. Retain this receipt for receipt-before-commit delivery.
    try {
      if(item.itemId!==refusal.approvalId || item.tool!==refusal.name ||
          p.sessionId!==refusal.sessionId || item.turnId!==refusal.turnId ||
          canonical(JSON.parse(item.args))!==canonical(refusal.args) ||
          item.status!=="rejected" || item.failureKind!=="approval_denied" ||
          item.failureReason!=="approval aborted" || b.pending.has(item.callId))
        throw new Error("identity or rejection differs from schema refusal");
      if(!refusal.settled) b.host?.ledger?.record("tool_schema_refusal_settled",{
        callId:item.callId,approvalId:refusal.approvalId,itemId:item.itemId,
        status:item.status,failureKind:item.failureKind,failureReason:item.failureReason,
        sourceRange:p.sourceRange,owner:"native-approval",piExecuted:false,
      });
      refusal.settled=true;
      const spec=b.batchSpec?.find(c=>c.callId===item.callId);
      if(spec) {
        if(!spec.nativeOnly)throw new Error("schema refusal targets executable Pi spec");
        spec.verified=true;settleBatch(b);
      }
    } catch(error:any) { fail(b,`Muse native schema refusal receipt: ${error.message}`); }
    return;
  }
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
      const receipt = toolResultReceipt(item, r, stored, spans => { redactions = spans; }, declared => { images = declared; });
      if (!b.bridge.verifyContent(pending.invocation, receipt))
        throw new Error("Muse tool result mismatch");
      if (redactions.length) {
        b.host?.ledger?.record("tool_result_vendor_redaction", {
          callId: item.callId, itemId: item.itemId, count: redactions.length,
          rule: "unique-nonempty-intraline-context-v2", spans: redactions,
          textProjection: r.content.length > 1 ? "lf-joined-text-parts" : "single-text",
          exactModelConsumption: false,
        });
        publishRedactionStatus(b, redactions.length);
      }
      if (images.length) b.host?.ledger?.record("tool_result_image_unverifiable", {
        callId: item.callId, piToolCallId: b.batchSpec?.find(c=>c.callId===item.callId)?.piCallId ?? pending.invocation.piCallId, itemId: item.itemId,
        images, delivered: true, unverifiableInContent: true,
        rule: "mcp-image-placeholder-v1", exactModelConsumption: false,
      });
      pending.verified = true;
      b.pending.delete(item.callId);
      const spec=b.batchSpec?.find(c=>c.callId===item.callId);
      if(spec)spec.verified=true;
      settleBatch(b);
    };
    if (item.outputRef) {
      b.verifyingReceipt = readStoredToolOutput(item, offset => {
        if (!b.host?.readToolOutput) throw new Error("Muse host cannot read item/outputRef");
        return b.host.readToolOutput(item, offset);
      }).then(verify).catch(error => { if (!b.closed) fail(b, `Muse tool result receipt: ${error.message}`); }).finally(() => {
        b.verifyingReceipt=undefined;
        const events=b.buffered.splice(0);
        for(const next of events)emitFrame(b,next);
      });
    } else {
      try { verify(); } catch(error:any) { fail(b, `Muse tool result receipt: ${error.message}`); }
    }
  }
}
function attach(b: Binding, e: Episode, signal?: AbortSignal) {
  b.detachTurnAbort?.();
  b.episode = e;
  b.host?.ledger?.beginEpisode(b.batch ? "handoff" : "turn");
  if (signal) {
    const abort = () => fail(b, "Request aborted");
    signal.addEventListener("abort", abort, { once: true });
    e.detachAbort = () => signal.removeEventListener("abort", abort);
    b.detachTurnAbort=e.detachAbort;
    if (signal.aborted) {
      abort();
      return;
    }
  }
  const events = b.buffered.splice(0);
  for (const event of events) emitFrame(b, event);
}
function surface(b: Binding, inv: BridgeInvocation) {
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
  if (!(config.toolBatches ?? true) || !b.host?.batches) {
    if(b.pending.size!==1){fail(b,"Concurrent Muse tools require committed batch capability");throw new Error("Missing tool batch");}
    b.batch=[callId];
    b.batchSpec=[{callId,name:`mcp__pi__${inv.name}`,args:inv.arguments,piCallId:inv.piCallId}];
  }
  const spec=b.batchSpec?.find(c=>c.callId===callId);
  if(spec?.journal)deliverResult(b,spec);
  flushTools(b);
}
function deliverResult(b:Binding,spec:NonNullable<Binding["batchSpec"]>[number]) {
  const pending=b.pending.get(spec.callId);
  if(!pending || !spec.journal || pending.result || b.closed)return;
  pending.result=spec.journal.response;
  b.bridge.journalResult({...pending.invocation,journalEntryId:spec.journal.entryId,result:spec.journal.response});
}
function flushTools(b: Binding) {
  const e=b.episode;
  if (!b.batch || b.batchSurfaced || !b.batchSpec) return;
  if (!e || e.ended) {fail(b,"Pi episode detached during committed MCP batch");return;}
  const executable=b.batchSpec.filter(c=>!c.nativeOnly);
  if(!executable.length)return; // Keep streaming until the native rejection receipt.
  b.batchSurfaced=true;
  if (e.textIndex !== undefined)
    e.stream.push({
      type: "text_end",
      contentIndex: e.textIndex,
      content: e.output.content[e.textIndex].text,
      partial: e.output,
    });
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
function streamViaMuse(model: any, input: any, options: any = {}) {
  if(config.modelAllowed && !config.modelAllowed(model)){
    const refused=createAssistantMessageEventStream();const output=message(model);output.stopReason="error";output.errorMessage="Muse model is not qualified for Pi prompt/compaction; select a catalogue-registered Spark 1.3 contributor, Wonder or Wonder Full route";
    refused.push({type:"error",reason:"error",error:output});refused.end();return refused;
  }
  const context = piContext(input);
  const requestedMode = selectMode(model);
  if (!context.tools.length) {
    if (rawCompletionQualified(model))
      return streamRawCompletion(model, context, options, message, openHost, "replace");
    // Refuse before looking up or attaching the coding binding. A failed summary
    // must not retire or settle an unrelated parked coding request.
    const refused=createAssistantMessageEventStream();const output=message(model);
    output.stopReason="error";output.errorMessage="Muse raw completion and compaction are unsupported: prompt delivery unqualified";
    refused.push({type:"error",reason:"error",error:output});refused.end();return refused;
  }
  const stream = createAssistantMessageEventStream();
  const output = message(model);
  const episode: Episode = { stream, output, ended: false };
  void (async () => {
    let b: Binding | undefined;
    try {
      museEffort(options.reasoning); // reject unknown tiers before host work
      const context = piContext(input);
      const owner = String(sessionManager?.getSessionId?.() ?? "");
      const key = String(options.sessionId ?? owner);
      const permit=compactionPermit;
      compactionPermit=undefined; // one Pi coding attempt, never a retry ticket
      const compactedContinuation=Boolean(permit && permit.manager===sessionManager &&
        sessionManager?.getBranch?.().at(-1)?.id===permit.boundary &&
        historyHash(context.messages)===permit.hash);
      if (compactedContinuation && permit!.overflow && retryBlocks.get(key)?.reason.startsWith("Muse context overflow:")) retryBlocks.delete(key);
      const blocked=retryBlocks.get(key);
      if(blocked && (blocked.hash===lastUserHash(context.messages) || context.messages.at(-1)?.role==="toolResult"))throw new Error((blocked.reason.startsWith("Muse native tool timeout:") || blocked.reason.startsWith("Muse approval hold:")) ? `${blocked.reason}; no automatic resubmit. Submit a new user request explicitly.` : "Muse prior request failed; no automatic resubmit. Submit a new user request explicitly.");
      // A genuinely new user request ends the old failure fence. Otherwise that
      // stale fence would incorrectly block this new request's later tool batch.
      if(blocked && context.messages.at(-1)?.role==="user")retryBlocks.delete(key);
      b = bindings.get(key);
      if (!context.tools.length)
        throw new Error("Muse raw completion and compaction are unsupported");
      const mode = requestedMode;
      assertPromptMode(capabilities, mode as PromptMode);
      if (model.id !== "echo" && process.env.PI_MUSE_TETHER_LIVE !== "1")
        throw new Error("Live Muse requires explicit PI_MUSE_TETHER_LIVE=1");
      if (!owner || key !== owner)
        throw new Error(
          "Pi session identity is required and must match the active journal",
        );
      const tools = context.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      }));
      const declarationHash = projectionHash(tools);
      const route = museModelRoute(model.id);
      const signature = requestSignature([model.id, route?.contributorMode, context.systemPrompt, tools, mode, process.cwd()]);
      b = bindings.get(key);
      if(b?.closed){await closeBinding(b);b=undefined;}
      if (options.signal?.aborted) {
        if (b) b.episode = episode;
        throw new Error("Request aborted");
      }
      if (b && (
        b.manager !== sessionManager || b.signature !== signature ||
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
        b.episode = episode;
        if (!b.batch) {
          const delta = context.messages.slice(b.messages.length);
          if (!delta.length || !delta.every((m:any)=>m.role === "user"))
            throw new Error("Muse completed-turn continuation requires an exact append of user messages");
          const text = museCurrentInput(delta);
          stream.push({ type: "start", partial: output });
          attach(b, episode, options.signal);
          if (b.closed) return;
          b.messages = structuredClone(context.messages);
          b.requestHash=lastUserHash(context.messages);
          b.messageHash = historyHash(b.messages);
          // Like the host's committed identities, refusals are native-turn scoped.
          // Call IDs may be reused in a later user turn, never within a repair.
          b.schemaRefusals.clear();
          await b.host!.submitInput(text, museEffort(options.reasoning));
          return;
        }
        const pendingBatch=b.batchSpec!.filter(c=>!c.nativeOnly);
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
        assertToolResultVerifiable(response);
        return {pending,entry,response};
        });
        stream.push({ type: "start", partial: output });
        attach(b, episode, options.signal);
        if (b.closed) return;
        b.messages = structuredClone(context.messages);
        b.requestHash=lastUserHash(context.messages);
        b.messageHash = historyHash(context.messages);
        b.steeringPending=steering.length>0;
        const consumed=steering.length?new Promise<void>(resolve=>{b!.receiptsDone=resolve;}):undefined;
        for(const {pending,entry,response} of journaled){
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
      const text = museHistoryInput(context.messages, compactedContinuation);
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
      const bridge = createMcpBridge({
        sessionId: key,
        generation: randomUUID(),
        tools,
        onInvocation: (inv) => surface(candidate, inv),
      });
      candidate = {
        key,
        requestHash:lastUserHash(context.messages),
        bridge,
        messages: structuredClone(context.messages),
        messageHash: historyHash(context.messages),
        declarationsHash: declarationHash,
        signature,
        park: parking && Boolean(sessionManager?.getSessionFile?.()),
        reservations,
        tools,
        schemaRefusals:new Map(),
        approvalHolds:new Map(),
        buffered: [],
        closed: false,
        usageIds: new Set(),
        pending: new Map(), batchSurfaced:false,
        manager: sessionManager,
        abort: new AbortController(),
      };
      b = candidate;
      bindings.set(key, b);
      stream.push({ type: "start", partial: output });
      attach(b, episode, options.signal);
      if (b.closed) return;
      const descriptor = await bridge.start();
      if (b.closed) return;
      const host = await (b.opening=openHost({
        cwd: process.cwd(),
        piSessionId: key,
        reasoningEffort: museEffort(options.reasoning),
        tools: tools.map((t: any) => t.name),
        promptMode: mode as PromptMode,
        ...(mode === "replace" ? {privatePrompt:{systemPrompt:context.systemPrompt}} : {}),
        echo: model.id === "echo",
        toolBatches: config.toolBatches ?? model.id !== "echo",
        model: model.id === "echo" ? undefined : route?.modelId ?? model.id,
        contributorMode: route?.contributorMode ?? "on",
        pickerModel: model.id,
        signal: b.abort.signal,
        mcpServers: { pi: { transport: "stdio", ...descriptor } },
        waitForToolReceipt: () => candidate.verifyingReceipt ? (async()=>{
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
            if (!validArguments(tool,request.toolCallId,args)) {
              const previous=candidate.schemaRefusals.get(request.toolCallId);
              if(previous && (previous.name!==request.toolName || canonical(previous.args)!==canonical(args) || previous.approvalId!==request.approvalId || previous.sessionId!==request.sessionId || previous.turnId!==request.turnId))return false;
              if(!previous) {
                candidate.schemaRefusals.set(request.toolCallId,{name:request.toolName,args,approvalId:request.approvalId,sessionId:request.sessionId,turnId:request.turnId,settled:false});
                candidate.host?.ledger?.record("tool_schema_refusal",{callId:request.toolCallId,approvalId:request.approvalId,tool:request.toolName,reason:"Pi tool argument schema or coercion rejected",owner:"tether-approval",piExecuted:false});
              }
              return false;
            }
            const spec=candidate.batchSpec?.find(c=>c.callId===request.toolCallId);
            if(candidate.closed || (candidate.batchSpec && (!spec || spec.verified || spec.name!==request.toolName || canonical(spec.args)!==canonical(args))))return false;
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
        },
        onEvent: (event: any) => emitFrame(candidate, event),
      }));
      b.host = host;
      host.ledger?.beginEpisode();
      if (b.closed || options.signal?.aborted) {
        await host.close();
        return;
      }
      await host.submitInput(text, museEffort(options.reasoning));
    } catch (error: any) {
      const reason = String(error?.message || error);
      if (b) { b.episode = episode; fail(b, reason); }
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
return {streamViaMuse,setSessionManager,retireAll,rawCompletionQualified,committedCompaction};
}
// Qualified against official Muse 1.4.14: private settings + explicit
// session/start workspaceRoot place exact Pi bytes in provider instructions.
const defaultProvider=createMuseProvider({promptModes:["none","replace"],promptMode:(model)=>isQualifiedMuseModel(model.id)?"replace":"none",instructionMechanisms:["private-xdg-settings"],rawCompletion:true,modelAllowed:(model)=>model.id==="echo"||isQualifiedMuseModel(model.id)});
export const {streamViaMuse,setSessionManager,retireAll,committedCompaction}=defaultProvider;
export const rawCompletionQualified=defaultProvider.rawCompletionQualified;
