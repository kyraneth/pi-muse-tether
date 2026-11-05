import { qualifyMuseVersion } from "./cli-version.js";
import { museEffort } from "./thinking-config.js";
import { publishQuota, quotaExhausted } from "./rate-limit.js";
import { MuseLedger } from "./request-ledger.js";
import type { TurnInputPart } from "./wire-types.js";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { writePromptSettings, promptSettings, discoverSkillsOff, linkHostLogin, assertLoginSafe, type SkillsOff } from "./settings.ts";
import { writeFile } from "node:fs/promises";
import {
  Connection, DiscardedSessions, MspError, Session, readSessionDurability,
  spawnMspConnection,
  type ApprovalHandler, type ExitClassification, type SessionFoldView,
  type SessionOptions, type SpawnMspConnectionOptions, type ViewEvent,
} from "@muse-code/sdk";

type InitializeResult = Parameters<typeof readSessionDurability>[0];
export type MuseApproval = Parameters<ApprovalHandler>[0];
export type MuseFrame = { method: string; params?: Record<string, unknown> };
export type MuseHostEvent =
  | { kind: "frame"; frame: MuseFrame }
  | { kind: "terminal"; turnId: string; status: "completed" | "cancelled" | "failed"; frame: MuseFrame; lastRetryHttpStatus?: number }
  | { kind: "fenced"; reason: string }
  | { kind: "tool-batch"; calls: Array<{callId:string;name:string;args:Record<string,unknown>}> }
  | { kind: "auth-metadata"; metadata: unknown }; 

export interface MuseHostOptions {
  cwd: string;
  /** Requires the pinned experimental rawLog batch boundary; never timing heuristics. */
  toolBatches?: boolean;
  purpose?: "coding" | "raw";
  piSessionId?: string;
  reasoningEffort?: ReturnType<typeof museEffort>;
  /** Filled from official model/list by openMuseHost, not a guessed ladder. */
  catalogueEfforts?: readonly string[];
  /** Private supported settings; session/start MUST name this host's cwd. */
  privatePrompt?: { systemPrompt: string; skillsOff?: SkillsOff };
  /** Owned by openMuseHost, never a credential-value reader. */
  verifyLogin?: () => Promise<unknown>;
  /** Exact Pi names, not namespace prefixes. Schemas belong to the broker. */
  tools: readonly string[];
  promptMode: "none" | "append" | "replace";
  mcpServers?: Record<string, unknown>;
  model?: string;
  /** Official CLI recipe selected by the local picker route; no auth change. */
  contributorMode?: "on" | "off";
  pickerModel?: string;
  /** Explicit offline selection. Live additionally requires the environment opt-in. */
  echo?: boolean;
  /** Absolute official binary path; useful when the test changes HOME. */
  binary?: string;
  onEvent?: (event: MuseHostEvent) => void;
  /** Stop an opening host when its Pi binding is retired. */
  signal?: AbortSignal;
  /**
   * Required to allow anything. Must validate identity and reserve the exact
   * generation, session, turn, approvalId, toolCallId and rawArgs for the later
   * broker request. A true answer is permission to reach the proxy, NOT execute.
   * Synchronous by design: no stale requirement can wait on human interaction.
   */
  validateApproval?: (request: Readonly<MuseApproval>) => boolean;
  /** Keep subsequent approvals behind an in-flight stored-output verification. */
  waitForToolReceipt?: () => Promise<void> | undefined;
  /** Hold an already validated offered approval until Pi has journaled its result.
   * Public SDK async approval handling; no MCP call or native result is forged. */
  waitForPiToolResult?: (request: Readonly<MuseApproval>) => Promise<void> | undefined;
}

let policyLatch: string | undefined;
export function assertMusePolicySafe() { if(policyLatch)throw new Error(policyLatch); }
export function policyDenial(error: unknown, seen=new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const value = error as Record<string, unknown>;
  if ([value.status, value.httpStatus, value.statusCode, value.code].includes(403) ||
    value.kind === "client_attestation_denied" || value.code === "client_attestation_denied") return true;
  // SDK errorKind is an open string. Only account/policy refusals latch;
  // quota and rate limits fence the current binding without poisoning later hosts.
  if ([value.errorKind, value.kind, value.code].some(v => typeof v === "string" &&
    /auth|attestation|policy|permission|forbidden/i.test(v))) return true;
  if (typeof value.message === "string" && /\bHTTP\s+403\b|\bclient_attestation_denied\b/.test(value.message)) return true;
  return [value.data, value.error, value.cause].some((nested) => nested !== error && policyDenial(nested, seen));
}

function quotaDenial(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const value = error as Record<string, unknown>;
  if ([value.status, value.httpStatus, value.statusCode, value.code].includes(429) || value.quota !== undefined ||
      [value.errorKind, value.kind, value.code].some(v => typeof v === "string" && /quota|plan.*limit|rate.?limit/i.test(v))) return true;
  return [value.data, value.error, value.cause].some(nested => quotaDenial(nested, seen));
}

const canonical = (v:any):string => v && typeof v === "object"
  ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);

function validateOptions(options: MuseHostOptions): void {
  assertMusePolicySafe();
  if (options.contributorMode !== undefined && !["on","off"].includes(options.contributorMode))
    throw new Error("Muse contributor mode must be on or off");
  const candidate = options.privatePrompt !== undefined && options.promptMode === "replace";
  if (options.privatePrompt && !candidate) throw new Error("Muse private prompt settings require replace mode");
  if (!options.echo) assertLoginSafe();
  if (options.promptMode !== "none" && !candidate) throw new Error("Muse prompt mode unsupported: no qualified instruction isolation");
  if (options.tools.length === 0 && !(options.purpose === "raw" && candidate)) throw new Error("Muse tools-empty/raw completion unsupported");
  if (options.purpose === "raw" && (options.tools.length || Object.keys(options.mcpServers ?? {}).length)) throw new Error("Muse raw completion must have no tools or MCP servers");
  if (Object.values(options.mcpServers ?? {}).some((server:any)=>server.mode !== undefined && server.mode !== "required")) throw new Error("Muse Pi MCP servers must be required; no optional fallback");
  if (options.echo !== true && process.env.PI_MUSE_TETHER_LIVE !== "1") throw new Error("Live Muse requires explicit PI_MUSE_TETHER_LIVE=1");
  if (new Set(options.tools).size !== options.tools.length || options.tools.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) {
    throw new Error("Pi tools must have distinct exact names (letters, digits, underscore or hyphen)");
  }
}

/** Supported official flags only; no config mutation, trust, login or credential I/O. */
export function museLaunchOptions(options: MuseHostOptions): SpawnMspConnectionOptions {
  validateOptions(options);
  const command = options.binary ?? process.env.PI_MUSE_TETHER_BINARY ?? join(homedir(), ".local/bin/muse");
  if (!isAbsolute(command)) throw new Error("Muse binary must be absolute");
  return {
    command,
    args: ["serve", ...(options.privatePrompt ? [] : ["--preset", "empty"]), "--no-session-log", "--contributor-mode", options.contributorMode ?? "on",
      // The disable-shell/write flags inject session-wide read-only developer
      // policy, incorrectly forbidding Pi MCP tools too. Supported named
      // selection removes native tools without making that false policy claim.
      // Apply at launch even without privatePrompt; [] keeps raw summaries empty.
      "--config", `run.toolset=${JSON.stringify(options.tools.map(name => `mcp__pi__${name}`))}`,
      "--disable-request-user-input", ...(options.echo ? ["--provider", "echo"] : [])],
    cwd: options.cwd,
    env: Object.fromEntries(Object.entries({ ...process.env, MUSE_NO_AUTO_UPDATE: "1" }).filter(([key]) => options.echo
      ? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "MUSE_NO_AUTO_UPDATE", "MUSE_WIRE_DIR", "MUSE_TRANSPORT_TRACE"].includes(key)
      : !["META_API_KEY", "MUSE_CONTRIBUTOR_MODE"].includes(key))),
    // No tether workload timeout: SDK SS2.1.2 owns the default 30s close deadline.
  };
}

/** Deliberately hides submit/replay/pending mutators from the driver-facing type. */
type Submission = { commandId: string; turnId?: string; terminal: boolean; started: boolean;
  admit?: () => void; refuse?: (error: Error) => void };

type SafeSession = Pick<Session, "sessionId" | "fold" | "apply" | "hostExited" |
  "onApproval" | "onApprovalError" | "stopRetrying"> & {
    readonly pending: Pick<Session["pending"], "size" | "list">;
  };

/**
 * One ephemeral host and one public SDK fold. Exported constructor is the
 * deterministic-test seam: tests still use a REAL public SDK Connection.
 * The caller must give this owner exclusive notification/request routing.
 */
export class MuseHost {
  #session?: SafeSession;
  #held: MuseFrame[] = [];
  #opening = false;
  #closing = false;
  #dead = false;
  #reason?: string;
  #submission?: Submission;
  #busy = false;
  #retrySafe = false;
  // Turn-scoped committed identities survive vendor stream retries and receipts.
  #committedCalls = new Map<string, string>();
  #committedBatches = new Set<string>();
  #lastRetryHttpStatus?: number;
  #logSubscription?: number;
  #steers = new Set<string>();
  #discarded = new DiscardedSessions();
  #closePromise?: Promise<void>;
  readonly #tools: ReadonlySet<string>;
  readonly #options: MuseHostOptions;
  readonly #durability: SessionOptions["durability"];
  readonly ledger: MuseLedger;
  private readonly connection: Connection;
  private readonly closeProcess: () => Promise<unknown>;
  private readonly makeSession: (options: SessionOptions) => Session;

  constructor(
    connection: Connection,
    initialized: InitializeResult,
    options: MuseHostOptions,
    closeProcess: () => Promise<unknown> = () => connection.close(),
    makeSession: (options: SessionOptions) => Session = (options) => new Session(options),
  ) {
    validateOptions(options);
    this.ledger = new MuseLedger(options.piSessionId??null,options.model??null,options.contributorMode??"on",options.pickerModel??options.model??null);
    this.connection = connection;
    this.closeProcess = closeProcess;
    this.makeSession = makeSession;
    this.#options = { ...options, tools: [...options.tools] };
    this.#tools = new Set(options.tools.map((name) => `mcp__pi__${name}`));
    this.#durability = readSessionDurability(initialized);
    if (this.#durability.kind !== "ephemeral") throw new Error("Muse requires declared ephemeral session durability");
    if (!initialized.grantedCapabilities.includes("sessionMcp")) throw new Error("Muse did not grant sessionMcp");
    if(options.toolBatches && !initialized.grantedCapabilities.includes("rawLog"))throw new Error("Muse rawLog capability absent; parallel tools unsupported");
    connection.onNotification((frame) => this.receive(frame as MuseFrame));
    connection.onServerRequest(async (request) => {
      if (request.method === "approval/request" || request.method === "userInput/request") {
        // Do not await session lookup, Session.apply().io or approval/decide.
        this.receive({ method: request.method === "userInput/request" ? "userInput/requested" : request.method,
          params: request.params });
        return {};
      }
      throw new MspError({ code: -32601, message: `method not found: ${request.method}`,
        data: { kind: "methodNotFound", retryable: false } });
    });
    connection.onProtocolError(() => this.fence("MSP protocol error"));
    void connection.closed.then(() => {
      if (!this.#closing) this.hostExited({ kind: "transportEof" });
    });
  }

  get sessionId(): string { if (!this.#session) throw new Error("Muse session not open"); return this.#session.sessionId; }
  get view(): SessionFoldView { if (!this.#session) throw new Error("Muse session not open"); return this.#session.fold; }
  get fencedReason(): string | undefined { return this.#reason; }
  get batches(): boolean { return this.#options.toolBatches === true; }
  /** Official read-only byte-ranged output API; no filesystem/path fallback. */
  async readToolOutput(item: { itemId: string; outputRef: { id: string } }, offsetBytes: number) {
    this.#assertLive();
    return this.connection.request("item/readOutput", { sessionId: this.sessionId,
      itemId: item.itemId, outputRef: item.outputRef.id, offsetBytes });
  }
  /** SDK Connection.command's documented nothing-admitted overload classes. */
  get retrySafe(): boolean { return this.#retrySafe; }
  #refusal(error:unknown) {
    if(!policyDenial(error))return false;
    policyLatch="Muse nonretryable provider refusal latched; account-owner review required";
    this.fence(policyLatch);return true;
  }

  #emit(event: MuseHostEvent): void {
    try { this.#options.onEvent?.(event); }
    catch { this.fence("Muse event consumer failed"); }
  }

  async open(): Promise<this> {
    if (this.#opening || this.#session) throw new Error("Muse session already opening/open");
    this.#assertLive();
    this.#opening = true;
    try {
      const raw = await this.connection.command("session/start", {
        approvalMode: "promptUnmatched",
        ...(this.#options.model === undefined ? {} : { modelId: this.#options.model }),
        // Without workspaceRoot, serve silently ignored run.system_prompt in
        // the live qualification. Explicit workspace construction is essential.
        ...(this.#options.privatePrompt ? {workspaceRoot: this.#options.cwd} : {}),
        config: { mcpServers: this.#options.mcpServers ?? {} },
      }, { maxAttempts: 1 }); // no engine retry/replay
      this.#assertLive();
      const result = raw as unknown as Extract<NonNullable<SessionOptions["opening"]>, { verb: "session/start" }>["result"];
      if (typeof result.session?.sessionId !== "string") throw new Error("Invalid Muse session/start result");
      if(this.#options.privatePrompt && (result.session as any).permissionState?.reviewerAuthority!=="human")
        throw new Error("Muse private recipe requires verified human reviewer; no model request submitted");
      this.#session = this.makeSession({ sessionId: result.session.sessionId, durability: this.#durability,
        discarded: this.#discarded, connection: this.connection, opening: { verb: "session/start", result } });
      this.ledger.opened(this.#session.sessionId);
      this.#session.onApproval(async (request) => {
        const waiting=this.#options.waitForToolReceipt?.();
        if(waiting)await waiting;
        // Refuse invalid/foreign requests immediately, without waiting for a Pi
        // result that must never exist. Reserve exact args before holding.
        const decision=this.#decide(request);
        if(decision.choiceId!=="allow_once")return decision;
        const result=this.#options.waitForPiToolResult?.(request);
        if(!result)return decision;
        await result;
        // Revalidate after the async hold; SDK echoes the exact requirementId.
        // The native server remains the stage-race authority.
        return this.#decide(request);
      });
      this.#session.onApprovalError((error) => { if(!this.#refusal(error))this.fence("Muse approval round trip failed"); });
      if(this.batches) {
        const streams=await this.connection.command("log/streams",{sessionId:this.sessionId},{maxAttempts:1});
        const stream=(streams.streams as any[])?.map(s=>s.stream).find(s=>s?.kind==="session.live" && s.id===this.sessionId);
        if(!stream)throw new Error("Muse rawLog session stream absent; parallel tools unsupported");
        const sub=await this.connection.command("log/subscribe",{sessionId:this.sessionId,stream},{maxAttempts:1});
        if(!(typeof sub.subscriptionId==="number" && Number.isFinite(sub.subscriptionId)))throw new Error("Muse rawLog subscription absent");
        this.#logSubscription=sub.subscriptionId;
      }
      // Entire drain is synchronous. A newly arriving event cannot overtake it.
      const held = this.#held;
      this.#held = [];
      for (const frame of held) if (frame.params?.sessionId === this.sessionId) this.#apply(frame);
      this.#assertLive();
      return this;
    } catch (error) {
      this.#refusal(error);
      this.fence(`Muse session open failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.#opening = false;
      this.#held = []; // unrelated sessions never survive open settlement
    }
  }

  /** The single ingress, also used by synthetic frame fixtures. */
  receive(frame: MuseFrame): void {
    if(frame.method==="log/gap" && (frame.params as any)?.subscriptionId===this.#logSubscription){this.fence("Muse rawLog gap; complete tool batch unknown");return;}
    if(frame.method==="log/record") {
      const p=frame.params as any;
      if(this.#logSubscription===undefined || p?.subscriptionId!==this.#logSubscription || this.#reason || this.#dead)return;
      const payload=p.record?.payload, event=payload?.event;
      if(payload?.kind==="run" && event?.kind==="assistant_tool_calls_committed") {
        if(!this.#busy || payload.run_id!==this.#submission?.turnId){this.fence("Muse committed tool batch has foreign turn identity");return;}
        try {
          const calls=event.tool_calls.map((c:any)=>({callId:c.call_id,name:c.name,args:typeof c.args==="string"?JSON.parse(c.args):c.args}));
          if(!calls.length || calls.some((c:any)=>typeof c.callId!=="string"||!this.#tools.has(c.name)||!c.args||typeof c.args!=="object"||Array.isArray(c.args)))throw new Error("Malformed committed tool batch");
          const signatures=calls.map((c:any)=>JSON.stringify([c.callId,c.name,canonical(c.args)]));
          const batch=JSON.stringify(signatures);
          if(this.#committedBatches.has(batch))return; // Same batch, including after receipts: never re-execute.
          if(new Set(calls.map((c:any)=>c.callId)).size!==calls.length || calls.some((c:any)=>this.#committedCalls.has(c.callId))) {
            this.fence("Muse conflicting or overlapping recommitted tool batch");return;
          }
          calls.forEach((c:any,i:number)=>this.#committedCalls.set(c.callId,signatures[i]));
          this.#committedBatches.add(batch);
          this.#emit({kind:"tool-batch",calls});
        }catch{this.fence("Muse malformed committed tool batch");}
      }
      return;
    }
    if (frame.method === "usage/changed") { publishQuota(frame.params); this.ledger.quota(frame.params); return; }
    if (typeof frame.params?.sessionId !== "string") return;
    if (this.#opening && !this.#session) { this.#held.push(frame); return; }
    if (this.#session && frame.params.sessionId === this.sessionId) this.#apply(frame);
  }

  #emptyPending(): boolean {
    const session = this.#session;
    if (!session || session.pending.size === 0) return true;
    // Must precede apply: queue movement can start replay I/O synchronously.
    for (const entry of session.pending.list()) session.stopRetrying(entry.commandId);
    this.fence("Unexpected SDK pending turn; retired before apply");
    return false;
  }

  #apply(frame: MuseFrame): void {
    if (!this.#session || !this.#emptyPending() || this.#dead) return;
    const params = frame.params!;
    const retry=["turn/retryScheduled","turn/modelRetryScheduled"].includes(frame.method);
    if(retry)this.ledger.observe(frame); // Includes refused retries, before any latch.
    // Only protocol error fields count; model/user/tool text is never scanned.
    if(policyDenial(params.error) || (["turn/retryScheduled","turn/modelRetryScheduled"].includes(frame.method) && policyDenial(params))){
      this.#emit({kind:"frame",frame});
      this.#refusal(policyDenial(params.error) ? params.error : params);return;
    }
    if (quotaDenial(params.error) || (retry && quotaDenial(params))) {
      this.#emit({kind:"frame",frame});
      this.fence("Muse quota refused; no replay"); return;
    }
    if(retry){
      if(!this.#busy || params.turnId!==this.#submission?.turnId) {
        this.fence("Muse retry has foreign or inactive turn identity");return;
      }
      // Only known transient kinds pass. Unknown/missing open-vocabulary kinds fail closed.
      if(!["server","transient"].includes(String(params.errorKind)) ||
        (params.httpStatus!==undefined && !(typeof params.httpStatus==="number" && params.httpStatus>=500 && params.httpStatus<=599))) {
        this.#emit({kind:"frame",frame});
        this.fence(`Muse nontransient or unknown retry kind: ${String(params.errorKind)} (HTTP ${String(params.httpStatus)})`);return;
      }
    }
    if(retry && typeof params.httpStatus==="number")this.#lastRetryHttpStatus=params.httpStatus;
    if (frame.method === "session/closed" && this.#busy) {
      this.fence("Muse session closed during pending work; no replay"); return;
    }
    if (this.#reason && frame.method !== "turn/completed") return;
    const item = params.item as Record<string, unknown> | undefined;
    if (this.#options.purpose === "raw" && (
      frame.method.startsWith("approval/") || frame.method.startsWith("userInput/") ||
      (item && !["agentMessage", "reasoning", "userMessage"].includes(String(item.kind)))
    )) { this.fence("Muse raw completion emitted tool/helper activity"); return; }
    if (frame.method === "view/gap" || frame.method.includes("snapshot") ||
      (frame.method === "turn/foregroundCompleted" && Array.isArray(params.blockingAgents) && params.blockingAgents.length > 0) ||
      (item && ["reminderChild", "subagent", "workflow", "userShell"].includes(String(item.kind)))) {
      this.fence("Unowned Muse activity or view gap"); return;
    }
    if (frame.method === "turn/started") {
      if (!this.#submission || params.commandId !== this.#submission.commandId) {
        this.fence("Unsolicited Muse turn"); return;
      }
      if (this.#submission.turnId !== undefined && this.#submission.turnId !== params.turnId) {
        this.fence("Mismatched Muse queued turn identity"); return;
      }
      this.#submission.turnId = String(params.turnId);
      this.#submission.started = true;
      this.#submission.admit?.();
    }
    if (item?.kind === "userMessage" && item.commandId !== this.#submission?.commandId && !this.#steers.has(String(item.commandId))) {
      this.fence("Unsolicited Muse user input"); return;
    }
    if (item?.kind === "toolCall" && !this.#tools.has(String(item.tool ?? item.toolName))) {
      this.fence("Undeclared Muse tool item"); return;
    }
    if (frame.method === "turn/completed" &&
      (!this.#submission?.turnId || params.turnId !== this.#submission.turnId ||
        !["completed", "cancelled", "failed"].includes(String(params.terminal)))) {
      this.fence("Unknown or foreign Muse terminal"); return;
    }
    try {
      const applied = this.#session.apply(frame as unknown as ViewEvent);
      // Approval I/O only; view/gap is refused before it can trigger recovery.
      void applied.io.catch(() => this.fence("Muse frame I/O failed"));
      if (frame.method === "userInput/requested") {
        this.fence("Unexpected Muse user input request"); return;
      }
      if(!retry)this.ledger.observe(frame); // exactly once at ingress, never provider-buffer replay
      if (!this.#reason) this.#emit({ kind: "frame", frame });
      if (frame.method === "turn/completed") {
        if (policyDenial(params.error)) {
          this.fence(`Muse nonretryable provider refusal: ${JSON.stringify(params.error)}`);
        }
        this.#submission!.terminal = true;
        const finish=()=>{
          if(this.#reason||this.#closing||this.#dead)return;
          this.#busy=false;
          this.#emit({kind:"terminal",turnId:String(params.turnId),status:params.terminal as "completed"|"cancelled"|"failed",frame,lastRetryHttpStatus:this.#lastRetryHttpStatus});
        };
        // Do not release a completed coding turn (and permit a new auxiliary
        // host) until refresh metadata is known safe. No credential bytes read.
        if(this.#options.verifyLogin)void this.#options.verifyLogin().then(finish,error=>this.fence(String(error?.message??error)));
        else finish();
      }
    } catch { this.fence("Muse fold refused frame"); }
  }

  #decide(request: MuseApproval): { choiceId: string } {
    let args: unknown;
    try { args = JSON.parse(request.rawArgs); } catch { args = undefined; }
    const scoped = !this.#reason && !this.#dead && this.#busy &&
      request.sessionId === this.sessionId && request.turnId === this.#submission?.turnId &&
      typeof request.toolCallId === "string" && request.toolCallId.length > 0 &&
      typeof request.approvalId === "string" && request.approvalId.length > 0 &&
      request.currentRequirementId.approvalId === request.approvalId &&
      request.subject.kind === "tool" && request.subject.toolName === request.toolName &&
      request.subagentOrigin === undefined && this.#tools.has(request.toolName) &&
      args !== null && typeof args === "object" && !Array.isArray(args);
    const oneShot = request.availableChoices.find((choice) =>
      choice.choiceId === "allow_once" && choice.decision === "approved" && choice.scope === "once");
    let allow = false;
    if (scoped && oneShot) {
      try { allow = this.#options.validateApproval?.(request) === true; }
      catch { allow = false; }
    }
    const choice = allow ? oneShot : request.availableChoices.find((choice) =>
      choice.decision === "denied" || choice.decision === "abort");
    if (!choice) {
      this.fence("Muse approval has no safe offered choice");
      throw new Error("No safe offered approval choice");
    }
    return { choiceId: choice.choiceId };
  }

  #assertLive(): void {
    assertMusePolicySafe();
    if (this.#closing || this.#dead || this.#reason) throw new Error(this.#reason ?? "Muse host closed");
  }

  async submitInput(text: string | TurnInputPart[], effort = this.#options.reasoningEffort ?? "none" as ReturnType<typeof museEffort>): Promise<{ turnId: string; commandId: string }> {
    if (this.#options.catalogueEfforts && !this.#options.catalogueEfforts.includes(effort))
      throw new Error(`Muse effort ${effort} absent from official model/list for ${this.#options.model}; no model request submitted`);
    this.#assertLive();
    if (!this.#session) throw new Error("Muse session not open");
    if (!this.#emptyPending()) this.#assertLive();
    if (this.#busy) throw new Error("Muse predecessor has no turn/completed terminal");
    await this.#options.verifyLogin?.();
    if (!this.#options.echo) {
      const result = await this.connection.request("usage/read", {}).catch(error=>{if(!this.#refusal(error) && quotaDenial(error))this.fence("Muse quota refused; no replay");throw error;});
      const usage = result.usage as any;
      publishQuota(usage); this.ledger.quota(usage);
      // Muse reports percentages; 100% is the provider's exhausted plan boundary.
      if (quotaExhausted(usage)) {
        this.fence("Muse plan usage limit reached; no turn submitted");
        throw new Error("Muse plan usage limit reached; no turn submitted");
      }
    }
    const commandId = this.connection.mintCommandId();
    const submission: Submission = { commandId, turnId: undefined, terminal: false, started: false };
    this.#submission = submission;
    this.#committedCalls.clear(); this.#committedBatches.clear(); this.#lastRetryHttpStatus=undefined;
    this.#retrySafe = false;
    this.#busy = true;
    try {
      // Never Session.sendUserTurn: the SDK replay producer remains empty.
      const ack = await this.connection.command("turn/start", { sessionId: this.sessionId,
        input: typeof text === "string" ? [{ type: "text", text }] : text, reasoningEffort: effort }, { commandId, maxAttempts: 1 });
      this.#assertLive();
      if (ack.commandId !== commandId || ack.status !== "accepted" || (ack.disposition !== "started" && ack.disposition !== "queued") ||
        typeof ack.turnId !== "string" || (submission.turnId !== undefined && submission.turnId !== ack.turnId)) {
        throw new Error("Muse raw turn was unserved or mismatched");
      }
      submission.turnId = ack.turnId;
      this.ledger.record("turn_admitted", {
        commandId, turnId: ack.turnId, disposition: ack.disposition,
        requestedEffort: effort, acceptance: "native:MSP-turn/start;not-physical-provider-effort",
        images: (typeof text === "string" ? [] : text.filter(p => p.type === "image")).map(p => {
          const bytes = Buffer.from(p.base64Data!, "base64");
          return { mediaType: p.mediaType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        }),
      });
      // MSP TurnStartDisposition: queue is the default when the host is busy.
      // Even just after turn/completed, dispatch may still be releasing its slot.
      // Admission is NOT execution: wait for this command's own turn/started.
      // No retry, SDK pending entry, timeout or additional turn/start is authored.
      if (ack.disposition === "queued" && !submission.started)
        await new Promise<void>((resolve, reject) => { submission.admit = resolve; submission.refuse = reject; });
      this.#assertLive();
      return { turnId: ack.turnId, commandId };
    } catch (error) {
      this.#retrySafe = !policyDenial(error) && !quotaDenial(error) && !submission.started && submission.turnId===undefined && error instanceof MspError &&
        ((error.code===-32001 && error.kind==="overloaded") || (error.code===-32031 && error.kind==="backpressured"));
      this.#refusal(error);
      if (quotaDenial(error) && !policyDenial(error)) {
        this.ledger.record("quota_refusal", {phase:"turn_admission"});
        this.fence("Muse quota refused; no replay");
      } else this.fence(`${policyDenial(error) ? "Muse nonretryable provider refusal" : "Muse turn admission failed; no replay"}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** Actual Pi user steering only; tool results never use this command. */
  async steerInput(text:string | TurnInputPart[]):Promise<void> {
    this.#assertLive();
    const turnId=this.#submission?.turnId;
    if(!turnId||!this.#busy||this.#submission?.terminal)throw new Error("Muse steering target completed; no resubmit");
    const commandId=this.connection.mintCommandId();this.#steers.add(commandId);
    try {
      const ack=await this.connection.command("turn/steer",{sessionId:this.sessionId,expectedTurnId:turnId,input:typeof text === "string" ? [{type:"text",text}] : text},{commandId,maxAttempts:1});
      if(ack.status!=="accepted"||ack.commandId!==commandId||ack.turnId!==turnId)throw new Error("Muse steering unconfirmed; no resubmit");
      this.#assertLive();
    }catch(error){this.#refusal(error);this.fence("Muse steering failed; no replay");throw error;}
  }

  async cancelTurn(): Promise<void> {
    const turnId = this.#submission?.turnId;
    if (!turnId || !this.#busy || this.#dead || this.#submission?.terminal) return;
    await this.connection.command("turn/cancel", { sessionId: this.sessionId, turnId }, { maxAttempts: 1 });
  }

  fence(reason: string): void {
    if (this.#reason) return;
    this.#reason = reason;
    this.ledger.retire("fenced", reason.split(":")[0].slice(0, 120));
    this.#submission?.refuse?.(new Error(reason));
    this.#emit({ kind: "fenced", reason });
    void this.cancelTurn().catch(() => undefined);
  }

  hostExited(exit: ExitClassification | { kind: "transportEof" }): void {
    // Report BOTH exit and EOF; public Session.hostExited owns idempotence.
    if (exit.kind === "cleanShutdown" && this.#closing) return;
    const death = exit.kind === "cleanShutdown" ? { kind: "transportEof" as const } : exit;
    this.#dead = true;
    this.ledger.record("process_exit",{exitKind:exit.kind});
    this.#session?.hostExited(death);
    this.fence(`Muse host died; ephemeral lineage discarded (${JSON.stringify(exit)})`);
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closing = true;
      this.ledger.retire("close");
      this.#submission?.refuse?.(new Error("Muse closed while awaiting queued admission; no replay"));
      this.#closePromise = Promise.resolve().then(async () => {
        try { if (!this.#options.echo && !this.#dead && !this.#reason) await this.connection.request("usage/read", {}); }
        finally { await this.closeProcess(); }
      });
    }
    return this.#closePromise;
  }
}

export async function discoverMuseCatalog() {
  const launch=museLaunchOptions({cwd:process.cwd(),tools:["read"],promptMode:"none"});
  await qualifyMuseVersion(launch.command,launch.env??{});
  const handshake = spawnMspConnection(launch);
  try {
    const spawned = await handshake.initialize({ clientInfo: { name: "pi_muse_tether", version: "0.1.1" },
      capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false } });
    const catalog = await spawned.connection.request("model/list", {});
    return catalog as typeof catalog & {models:any[]};
  } catch (error) {
    if (policyDenial(error)) policyLatch="Muse nonretryable provider refusal latched; account-owner review required";
    throw error;
  } finally { await handshake.close(); }
}

export async function openMuseHost(options: MuseHostOptions): Promise<MuseHost> {
  const launch = museLaunchOptions(options); // preflight BEFORE filesystem/process work
  options.signal?.throwIfAborted();
  await qualifyMuseVersion(launch.command, launch.env??{}, options.signal, options.toolBatches);
  const home = await mkdtemp(join(tmpdir(), "pi-muse-host-"));
  const env = options.echo ? { ...launch.env,
    HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") } : {
    ...launch.env, ...(options.privatePrompt ? {XDG_CONFIG_HOME:join(home,"config")} : {})};
  let verifyLogin:(()=>Promise<unknown>)|undefined, cleaned=false;
  let host: MuseHost | undefined;
  const cleanup=async()=>{
    if(cleaned)return;cleaned=true;
    if(verifyLogin)await verifyLogin();
    // If verification throws, preserve the private metadata file and stop. Never
    // delete a possible rotated credential or repair the account owner's login automatically.
    await rm(home,{recursive:true,force:true});
  };
  try {
    if (options.privatePrompt) {
      await writePromptSettings(home, options.privatePrompt.systemPrompt, options.tools, options.privatePrompt.skillsOff);
      if(!options.echo){
        const verify=await linkHostLogin(home,launch.env?.XDG_CONFIG_HOME??join(homedir(),".config"));
        verifyLogin=async()=>{
          const metadata=await verify();
          if(metadata.realMetadataChanged)host?.ledger.record("auth_metadata_change",{metadata});
          options.onEvent?.({kind:"auth-metadata",metadata});
          return metadata;
        };
      }
      const skills=options.privatePrompt.skillsOff??await discoverSkillsOff(launch.command,options.cwd,env);
      // Inventory is finished before the model host starts. Only this generation
      // can see this settings path; auxiliary summaries stage their own files.
      await writeFile(join(home,"config/muse/settings.json"),JSON.stringify(promptSettings(options.privatePrompt.systemPrompt,options.tools,skills)),{mode:0o600});
    }
  } catch (error) { await cleanup(); throw error; }
  const handshake = spawnMspConnection({ ...launch, env });
  const abortOpen = () => { void handshake.close().catch(() => undefined); };
  options.signal?.addEventListener("abort", abortOpen, { once: true });
  if (options.signal?.aborted) abortOpen();
  // Capture frames from process birth, not just session/start. Never await a receipt.
  const held: MuseFrame[] = [];
  handshake.onNotification((frame) => held.push(frame as MuseFrame));
  handshake.onServerRequest(async (request) => {
    if (request.method !== "approval/request" && request.method !== "userInput/request") {
      throw new MspError({ code: -32601, message: `method not found: ${request.method}`,
        data: { kind: "methodNotFound", retryable: false } });
    }
    held.push({ method: request.method === "userInput/request" ? "userInput/requested" : request.method, params: request.params });
    return {};
  });
  try {
    const spawned = await handshake.initialize({ clientInfo: { name: "pi_muse_tether", version: "0.1.1" },
      capabilities: { requestedCapabilities: ["sessionMcp",...(options.toolBatches?["rawLog"]:[])], userInputDialogs: false, ...((options.privatePrompt||options.toolBatches)?{experimentalApi:true}:{}) } });
    if(options.toolBatches && !spawned.initializeResult.grantedCapabilities.includes("rawLog"))throw new Error("Muse rawLog capability absent; parallel tools unsupported; no model request submitted");
    if (!options.echo) {
      const catalog = await spawned.connection.request("model/list", {});
      const selected = (catalog.models as any[])?.find((m) => m.modelId === options.model);
      if (catalog.source !== "providerCatalog" || !selected)
        throw new Error("Selected model absent from official Muse model/list providerCatalog");
      const effort = options.reasoningEffort ?? "none";
      if (!Array.isArray(selected.variants) || !selected.variants.includes(effort))
        throw new Error(`Muse effort ${effort} absent from official model/list for ${options.model}; no model request submitted`);
      options = {...options, catalogueEfforts: [...selected.variants]};
    }
    host = new MuseHost(spawned.connection, spawned.initializeResult, {...options,verifyLogin}, async () => {
      try { await spawned.close(); } finally { await cleanup(); }
    });
    void spawned.child.exit.then((exit) => host!.hostExited(exit));
    // These pre-open frames cannot belong to a newly created root session.
    held.length = 0;
    return await host.open();
  } catch (error) {
    if(policyDenial(error))policyLatch="Muse nonretryable provider refusal latched; account-owner review required";
    await (host ? host.close() : handshake.close()).catch(() => undefined);
    await cleanup();
    throw error;
  } finally { options.signal?.removeEventListener("abort", abortOpen); }
}
