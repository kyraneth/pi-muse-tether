import { resolveMuseBinary, batchEligibility, clientBuildLabel } from "./qualification-records.js";
import { featureNotice, featureActive, MuseFeatureUnavailable } from "./features.js";
import { committedCalls } from "./batch-schema.js";
import { isNewerThanTestedCli, qualifyMuseVersion } from "./cli-version.js";
import { catalogueIdentity, refreshCatalogueFromHost } from "./catalog-cache.js";
import { resolveMuseEffort } from "./thinking-config.js";
import { museCatalogAssessment } from "./catalog.js";
import { hasQuotaData, publishQuota, quotaExhausted, quotaExhaustedResetIso } from "./rate-limit.js";
import { retryCause } from "./retry-status.js";
import { MuseLedger } from "./request-ledger.js";
import type { TurnInputPart } from "./wire-types.js";
import { NATIVE_SEARCH_TOOL, nativeSearchRefusal, strictMuse, searchQuery, searchSources, type NativeSearchEntry } from "./native-search.js";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { inputParts, MUSE_INBOUND_FRAME_LIMIT_BYTES, MuseFrameOverInboundLimit, turnStartFrameBytes } from "./turn-plan.js";
import { rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute, join } from "node:path";
import { createVendorRoot, vendorProcessEnv, seedVendorCatalogue, writePromptSettings, privateWorkspace, promptSettings, museToolset, discoverSkillsOff, linkHostLogin, assertLoginSafe, type SkillsOff } from "./settings.ts";
import {
  Connection, DiscardedSessions, MspError, Session, readSessionDurability,
  spawnMspConnection,
  type ApprovalHandler, type ExitClassification, type SessionFoldView,
  type SessionOptions, type SpawnMspConnectionOptions, type ViewEvent,
} from "@muse-code/sdk";

/** Inventory recheck pacing while Muse 1.4.15 starts session MCP (~200 ms measured). */
const MCP_READY_RECHECK_MS = 25;

export {MUSE_INBOUND_FRAME_LIMIT_BYTES,MuseFrameOverInboundLimit} from "./turn-plan.js";

/** The client's own refusal of an oversized frame, reported with its limit. */
function inputTooLarge(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, any>;
  const kind = value.kind ?? value.errorKind ?? value.data?.kind;
  if (value.code !== -32002 || kind !== "inputTooLarge") return undefined;
  const limit = value.data?.limitBytes ?? value.limitBytes;
  return typeof limit === "number" && limit > 0 ? limit : MUSE_INBOUND_FRAME_LIMIT_BYTES;
}

type StagedTerminal = Extract<MuseHostEvent,{kind:"terminal"}>;
type InitializeResult = Parameters<typeof readSessionDurability>[0];
export type MuseApproval = Parameters<ApprovalHandler>[0];
export type MuseFrame = { method: string; params?: Record<string, unknown> };
export type MuseHostEvent =
  | { kind: "frame"; frame: MuseFrame }
  | { kind: "terminal"; turnId: string; status: "completed" | "cancelled" | "failed"; frame: MuseFrame; lastRetryHttpStatus?: number; lastRetryCause?: string }
  | { kind: "admission-refused"; httpStatus?: number }
  | { kind: "fenced"; reason: string }
  | { kind: "degraded"; feature: "rawLog"; reason: string }
  | { kind: "tool-batch"; calls: Array<{callId:string;name:string;args:Record<string,unknown>}> }
  | { kind: "native-search"; entry: NativeSearchEntry }
  | { kind: "auth-metadata"; metadata: unknown };

export interface MuseHostOptions {
  cwd: string;
  /** Requires the pinned experimental rawLog batch boundary; never timing heuristics. */
  toolBatches?: boolean;
  /** Only the explicitly isolated, opt-in qualifier can probe before certification. */
  qualificationProbe?: boolean;
  clientBuild?: string;
  purpose?: "coding" | "raw";
  /** Separately permitted on a live, journal-owned chat, never a replay stage. */
  nativeSearch?: boolean;
  piSessionId?: string;
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
  /** Set by openMuseHost for private prompts: the empty trusted workspace. */
  privateWorkspace?: string;
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

export class MuseUpgradeRequired extends Error {
  readonly code = "MUSE_UPGRADE_REQUIRED";
  constructor(readonly build: string) { super(`MUSE_UPGRADE_REQUIRED: Meta requires a newer official client than ${build}; update through Meta's launcher, then run /muse-doctor qualify. No fallback or replay.`); }
}
export function serverRequiresUpgrade(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error); const value=error as Record<string,unknown>;
  if ([value.status,value.httpStatus,value.code].includes(426) || [value.kind,value.errorKind,value.code].some(v => typeof v === "string" && /^(upgrade_required|client_version_unsupported|minimum_client_version|client_upgrade_required)$/.test(v))) return true;
  return [value.error,value.data,value.cause].some(nested => serverRequiresUpgrade(nested,seen));
}
const QUOTA_EXHAUSTION_MESSAGE = /quota\s*(?:exhausted|exceeded|limit|reached)|insufficient_quota|usage\s+limit\s+reached|plan\s+limit/i;

/**
 * Definitive quota exhaustion only. Temporary HTTP 429 / rate-limit bursts
 * belong to Muse Code's own retry chain and must not be fenced as exhausted
 * subscription quota.
 */
function quotaDenial(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const value = error as Record<string, unknown>;
  if (value.quota !== undefined && value.quota !== null && typeof value.quota === "object") return true;
  if ([value.errorKind, value.kind, value.code].some(v => typeof v === "string" && /quota|plan.*limit/i.test(v))) return true;
  if ([value.message, value.reason].some(v => typeof v === "string" && QUOTA_EXHAUSTION_MESSAGE.test(v))) return true;
  return [value.data, value.error, value.cause].some(nested => quotaDenial(nested, seen));
}

function quotaDetails(error: unknown, seen = new Set<unknown>()): { limitKind?: string; resetsAtMs?: number; message?: string } {
  if (!error || typeof error !== "object" || seen.has(error)) return {};
  seen.add(error);
  const value = error as Record<string, any>;
  let limitKind = typeof value.quota?.limitKind === "string" && value.quota.limitKind ? value.quota.limitKind : undefined;
  let resetsAtMs = typeof value.quota?.resetsAtMs === "number" && Number.isFinite(value.quota.resetsAtMs)
    ? value.quota.resetsAtMs
    : typeof value.resetsAtMs === "number" && Number.isFinite(value.resetsAtMs)
      ? value.resetsAtMs
      : undefined;
  let message = [value.message, value.reason].find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
  for (const nested of [value.error, value.data, value.cause]) {
    if (!nested || nested === error) continue;
    const child = quotaDetails(nested, seen);
    limitKind ??= child.limitKind;
    resetsAtMs ??= child.resetsAtMs;
    message ??= child.message;
  }
  return { limitKind, resetsAtMs, message };
}

/**
 * Format a quota fence preserving the provider's message and reset time while
 * keeping "quota exceeded" in the prefix so Pi never auto-retries even when the
 * provider text contains "429" or "rate_limit_error".
 */
function quotaFenceMessage(error: unknown): string {
  const { limitKind, resetsAtMs, message } = quotaDetails(error);
  const meta = [limitKind, resetsAtMs !== undefined ? `resets at ${new Date(resetsAtMs).toISOString()}` : undefined]
    .filter(Boolean)
    .join(", ");
  const detail = [meta, message].filter(Boolean).join(" — ");
  return detail
    ? `Muse quota refused (quota exceeded); no replay: ${detail}`
    : "Muse quota refused (quota exceeded); no replay";
}

const canonical = (v:any):string => v && typeof v === "object"
  ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);

function validateOptions(options: MuseHostOptions): void {
  assertMusePolicySafe();
  if (options.contributorMode !== undefined && !["on","off"].includes(options.contributorMode))
    throw new Error("Muse contributor mode must be on or off");
  const candidate = options.privatePrompt !== undefined && options.promptMode === "replace";
  const appended = options.privatePrompt !== undefined && options.promptMode === "append";
  if (options.nativeSearch && strictMuse()) throw new Error(nativeSearchRefusal);
  if (options.nativeSearch && (options.echo || !candidate)) throw new Error("Muse native search requires live private prompt replacement; no prompt was sent.");
  if (options.privatePrompt && !candidate && !appended) throw new Error("Muse private prompt settings require replace or appended fallback mode");
  if (!options.echo) assertLoginSafe();
  if (options.promptMode !== "none" && !candidate && !appended) throw new Error("Muse prompt mode unsupported: no instruction mechanism");
  if (options.tools.length === 0 && !(options.purpose === "raw" && (candidate || appended))) throw new Error("Muse tools-empty/raw completion unsupported");
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
  const command = options.binary ?? resolveMuseBinary();
  if (!isAbsolute(command)) throw new Error("Muse binary must be absolute");
  return {
    command,
    connection: {mintRequestId:randomUUID},
    args: ["serve", ...(options.privatePrompt ? [] : ["--preset", "empty"]), "--no-session-log", "--contributor-mode", options.contributorMode ?? "on",
      // The disable-shell/write flags inject session-wide read-only developer
      // policy, incorrectly forbidding Pi MCP tools too. Supported named
      // selection removes native tools without making that false policy claim.
      // Apply at launch even without privatePrompt; [] keeps raw summaries empty.
      "--config", `run.toolset=${JSON.stringify(museToolset(options.tools, options.nativeSearch))}`,
      ...(options.nativeSearch ? ["--config", 'tools.web_search.mode="client"', "--config", "tools.web_fetch.enabled=false"] : []),
      "--disable-request-user-input", ...(options.echo ? ["--provider", "echo"] : [])],
    cwd: options.cwd,
    env: Object.fromEntries(Object.entries({ ...process.env }).filter(([key]) => options.echo
      ? ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "MUSE_NO_AUTO_UPDATE", "MUSE_WIRE_DIR", "MUSE_TRANSPORT_TRACE"].includes(key)
      : !["META_API_KEY", "MUSE_CONTRIBUTOR_MODE"].includes(key))),
    // No tether workload timeout: SDK SS2.1.2 owns the default 30s close deadline.
  };
}

/** The private host owns one workspace, one Pi broker and one Muse session.
 * Only the settings-file registry exposes Muse's per-server tool deadline.
 * The same name in both registries is rejected by session/start. */
function privatePiMcp(options: MuseHostOptions) {
  if (!options.privateWorkspace) return undefined;
  const pi = options.mcpServers?.pi as {transport?: string; command?: string; framing?: string} | undefined;
  if (pi?.transport !== "stdio" || !pi.command) return undefined;
  const framing = pi.framing === "lineDelimitedJson" ? "line_delimited_json"
    : pi.framing === "contentLength" ? "content_length" : pi.framing;
  return {
    ...pi, framing, mode: "required",
    // Muse documents no unlimited value. Match the Claude tether's existing
    // one-hour DEFAULT_MCP_TOOL_TIMEOUT_MS (pi-claude-tether src/process-manager.ts).
    // https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/mcp-servers/
    tool_timeout_sec: 3600,
  };
}

/** Deliberately hides submit/replay/pending mutators from the driver-facing type. */
type Submission = { commandId: string; turnId?: string; terminal: boolean; started: boolean; preIdentity?: MuseFrame[];
  admit?: () => void; refuse?: (error: Error) => void;
  searches?: Map<string, {itemId: string; query: string | null; completed: boolean}> };

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
  #stage?: {complete:(event:StagedTerminal)=>void; reject:(error:Error)=>void};
  #retrySafe = true; // No turn/start has been sent for this attempt.
  // Turn-scoped committed identities survive vendor stream retries and receipts.
  #committedCalls = new Map<string, string>();
  #committedBatches = new Set<string>();
  #lastRetryHttpStatus?: number;
  #lastRetryCause?: string;
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
    if (!initialized.grantedCapabilities.includes("sessionMcp")) throw new MuseFeatureUnavailable(options.clientBuild ?? "unknown build","sessionMcp","initialize did not grant session MCP");
    featureActive(options.clientBuild ?? "unknown build","sessionMcp");
    if(options.toolBatches && !initialized.grantedCapabilities.includes("rawLog")) {
      this.#options.toolBatches=false;
      this.degradeBatches("rawLog not granted");
    }
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
  #degradationRecorded = false;
  degradeBatches(reason: string) {
    this.#options.toolBatches=false;
    if (!this.#degradationRecorded) {
      this.#degradationRecorded=true;
      const build = this.#options.clientBuild ?? "unknown build", fallback = "using sequential tools (no replay)";
      const notice = featureNotice(build,"rawLog",reason,fallback);
      this.ledger.record("route_degraded",{build,feature:"rawLog",reason,fallback});
      if (this.#busy) console.warn(notice); // An in-flight batch actually lost its rawLog path.
      this.#emit({kind:"degraded",feature:"rawLog",reason});
    }
  }
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
    if (serverRequiresUpgrade(error)) {
      const build = this.#options.clientBuild ?? clientBuildLabel(this.#options.binary ?? process.env.PI_MUSE_TETHER_BINARY);
      this.fence(new MuseUpgradeRequired(build).message); return true;
    }
    if(!policyDenial(error))return false;
    policyLatch="Muse nonretryable provider refusal latched; account-owner review required";
    this.fence(policyLatch);return true;
  }

  #emit(event: MuseHostEvent): void {
    if (this.#stage) {
      if (event.kind === "terminal") this.#stage.complete(event);
      if (event.kind === "fenced") this.#stage.reject(new Error(event.reason));
      return; // A stage has no visible Pi episode, response hook or tool dispatch.
    }
    try { this.#options.onEvent?.(event); }
    catch { this.fence("Muse event consumer failed"); }
  }

  async open(): Promise<this> {
    if (this.#opening || this.#session) throw new Error("Muse session already opening/open");
    this.#assertLive();
    this.#opening = true;
    try {
      const mcpServers = { ...this.#options.mcpServers };
      if (privatePiMcp(this.#options)) delete mcpServers.pi;
      const raw = await this.connection.command("session/start", {
        approvalMode: "promptUnmatched",
        ...(this.#options.model === undefined ? {} : { modelId: this.#options.model }),
        // Without workspaceRoot, serve silently ignored run.system_prompt in
        // the live qualification. Explicit workspace construction is essential;
        // the private trusted workspace keeps project rules out (settings.ts).
        ...(this.#options.privatePrompt ? {workspaceRoot: this.#options.privateWorkspace ?? this.#options.cwd} : {}),
        config: { mcpServers },
      }, { maxAttempts: 1 }); // no engine retry/replay
      this.#assertLive();
      const result = raw as unknown as Extract<NonNullable<SessionOptions["opening"]>, { verb: "session/start" }>["result"];
      if (typeof result.session?.sessionId !== "string") throw new Error("Invalid Muse session/start result");
      if(this.#options.privatePrompt && (result.session as any).permissionState?.reviewerAuthority!=="human")
        throw new MuseFeatureUnavailable(this.#options.clientBuild ?? "unknown build","sessionMcp","Private tool recipe lacks verified human reviewer; Pi cannot safely own approvals");
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
      this.#session.onApprovalError((failure) => {
        if (!this.#refusal(failure) && (!this.#closing || "error" in failure && failure.error instanceof MspError))
          this.fence("Muse approval round trip failed");
      });
      if(this.batches) { try {
        const streams=await this.connection.command("log/streams",{sessionId:this.sessionId},{maxAttempts:1});
        const stream=(streams.streams as any[])?.map(s=>s.stream).find(s=>s?.kind==="session.live" && s.id===this.sessionId);
        if(!stream)throw new Error("Muse rawLog session stream absent; parallel tools unsupported");
        const sub=await this.connection.command("log/subscribe",{sessionId:this.sessionId,stream},{maxAttempts:1});
        if(!(typeof sub.subscriptionId==="number" && Number.isFinite(sub.subscriptionId)))throw new Error("Muse rawLog subscription absent");
        this.#logSubscription=sub.subscriptionId;
      } catch (error) {
        if (policyDenial(error)) throw error;
        this.degradeBatches("rawLog schema/subscription unavailable");
      } }
      try { await this.#awaitSessionMcp(); }
      catch(error) {
        if (this.#options.signal?.aborted || policyDenial(error)) throw error;
        throw new MuseFeatureUnavailable(this.#options.clientBuild ?? "unknown build","sessionMcp",error instanceof Error ? error.message : String(error));
      }
      // Entire drain is synchronous. A newly arriving event cannot overtake it.
      const held = this.#held;
      this.#held = [];
      for (const frame of held) if (frame.params?.sessionId === this.sessionId) this.#apply(frame);
      this.#assertLive();
      return this;
    } catch (error) {
      if (!this.#refusal(error) && !this.#closing)
        this.fence(`Muse session open failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.#opening = false;
      this.#held = []; // unrelated sessions never survive open settlement
    }
  }

  /** Muse 1.4.15 starts session MCP servers after session/start returns, and
   * a turn sent first fails "unknown tool" (measured 2026-11-10: "starting"
   * with no tools, "connected" ~200 ms later). The client sends no readiness
   * notification, so ask its inventory until every required server is
   * connected with every Pi tool. No deadline: Pi's abort owns cancellation.
   * 1.4.14 has no inventory method and was already ready at session/start. */
  async #awaitSessionMcp() {
    const names = Object.keys(this.#options.mcpServers ?? {});
    for (;;) {
      if (!names.length) return;
      this.#assertLive();
      this.#options.signal?.throwIfAborted();
      let inventory: any;
      try {
        inventory = await (this.connection as any).request("mcpServer/readInventory", { sessionId: this.sessionId, includeTools: true });
      } catch (error: any) {
        // Only the typed old-client refusal skips readiness. experimentalRequired
        // also uses -32601; a frame without data.kind is rejected by the SDK as
        // ProtocolError (fail-closed), not evidence of an older client.
        if (error?.kind === "methodNotFound" || error?.data?.kind === "methodNotFound") return;
        throw error;
      }
      if (!Array.isArray(inventory?.servers)) throw new Error("Muse session MCP inventory malformed: servers must be an array");
      const rows = names.map(name => ({ name, row: inventory.servers.find((s: any) => s?.name === name) }));
      // Registration can be asynchronous: absent rows and starting are pending.
      // 1.4.15 binary inventory labels include withheld and closed. These,
      // explicit failures (failed/error/forfeited), and all unrecognized states
      // fail closed, naming the state; only starting/absence are pending.
      const failed = rows.find(({ row }) => row && row.state !== "starting" && row.state !== "connected");
      if (failed) throw new Error(`Muse session MCP server ${failed.name} unavailable (${failed.row?.state ?? "absent"}); no model request submitted`);
      if (rows.every(({ row }) => row?.state === "connected")) {
        const pi = rows.find(({ name }) => name === "pi")?.row;
        const missing = pi ? this.#options.tools.filter(tool => !(pi.tools as unknown[] | undefined)?.includes(tool)) : [];
        if (missing.length) throw new Error(`Muse session MCP server pi connected without Pi tools ${missing.join(", ")}; no model request submitted`);
        return;
      }
      // Recheck pacing only (not a deadline), well under the measured ~200 ms startup.
      await delay(MCP_READY_RECHECK_MS, undefined, { signal: this.#options.signal });
    }
  }

  /** The single ingress, also used by synthetic frame fixtures. */
  receive(frame: MuseFrame): void {
    if (this.#closing && frame.method.startsWith("log/")) return;
    if(frame.method==="log/gap" && (frame.params as any)?.subscriptionId===this.#logSubscription){
      if (this.#stage) this.fence("Muse staged replay encountered a rawLog gap; no replay");
      else this.degradeBatches("rawLog gap");
      return;
    }
    if(frame.method==="log/record") {
      const p=frame.params as any;
      if(this.#logSubscription===undefined || p?.subscriptionId!==this.#logSubscription || this.#reason || this.#dead || this.#closing)return;
      const payload=p.record?.payload, event=payload?.event;
      if(this.#stage && event?.kind==="assistant_tool_calls_committed") {this.fence("Muse staged replay attempted tool work; no replay");return;}
      if(this.batches && payload?.kind==="run" && event?.kind==="assistant_tool_calls_committed") {
        if(!this.#busy || payload.run_id!==this.#submission?.turnId){this.fence("Muse committed tool batch has foreign turn identity");return;}
        try {
          const calls=committedCalls(p);
          if (!calls.length || calls.some(c => !this.#tools.has(c.name) &&
              !(this.#options.nativeSearch && c.name === NATIVE_SEARCH_TOOL))) throw new Error("Malformed committed tool batch");
          const signatures=calls.map((c:any)=>JSON.stringify([c.callId,c.name,canonical(c.args)]));
          const batch=JSON.stringify(signatures);
          if(this.#committedBatches.has(batch))return; // Same batch, including after receipts: never re-execute.
          if(new Set(calls.map((c:any)=>c.callId)).size!==calls.length || calls.some((c:any)=>this.#committedCalls.has(c.callId))) {
            this.fence("Muse conflicting or overlapping recommitted tool batch");return;
          }
          calls.forEach((c:any,i:number)=>this.#committedCalls.set(c.callId,signatures[i]));
          this.#committedBatches.add(batch);
          const piCalls = this.#options.nativeSearch ? calls.filter(c => this.#tools.has(c.name)) : calls;
          if (piCalls.length) this.#emit({kind:"tool-batch",calls:piCalls});
        }catch{
          this.degradeBatches("Batch schema mismatch");
        }
      }
      return;
    }
    if (frame.method === "usage/changed") {
      if (hasQuotaData(frame.params)) { publishQuota(frame.params); this.ledger.quota(frame.params); }
      return;
    }
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
    if(serverRequiresUpgrade(params.error) || (retry && serverRequiresUpgrade(params)) || policyDenial(params.error) || (["turn/retryScheduled","turn/modelRetryScheduled"].includes(frame.method) && policyDenial(params))){
      this.#emit({kind:"frame",frame});
      this.#refusal(policyDenial(params.error) || serverRequiresUpgrade(params.error) ? params.error : params);return;
    }
    if (quotaDenial(params.error) || (retry && quotaDenial(params))) {
      this.#emit({kind:"frame",frame});
      this.fence(quotaFenceMessage(quotaDenial(params.error) ? params.error : params)); return;
    }
    if(retry){
      if(!this.#busy || params.turnId!==this.#submission?.turnId) {
        this.fence("Muse retry has foreign or inactive turn identity");return;
      }
      // A scheduled retry is the vendor's own backoff inside an already admitted
      // turn, and its durable kind vocabulary is open (`errorKind?: string`). Real
      // Wonder Full turns sent a kindless `turn/retryScheduled` (2026-11-11T20:34
      // and 20:43) with no 5xx anywhere in the turn, and the old fence ended them.
      // An unknown or missing kind must not end live work; account, quota, policy
      // and upgrade refusals were already decided above, and the terminal frame
      // still reports the real outcome and status.
      if(typeof params.httpStatus==="number" && Number.isFinite(params.httpStatus))this.#lastRetryHttpStatus=params.httpStatus;
      const cause = retryCause(params);
      if (cause) this.#lastRetryCause = cause;
    }
    if (frame.method === "session/closed") {
      // Ingress already checked this host's session ID. Only the orderly
      // shutdown of that session is expected after our SDK close began.
      if (this.#closing && params.reason === "hostShutdown") return;
      if (this.#busy) { this.fence("Muse session closed during pending work; no replay"); return; }
    }
    if (this.#reason && frame.method !== "turn/completed") return;
    const item = params.item as Record<string, unknown> | undefined;
    const nativeSearch = this.#options.nativeSearch && !this.#stage && item?.kind === "toolCall" && item.tool === NATIVE_SEARCH_TOOL;
    if (this.#options.nativeSearch && item?.kind === "webSearch") {
      this.fence("Muse emitted hosted search under the client-only recipe"); return;
    }
    if ((this.#options.purpose === "raw" || this.#stage) && (
      frame.method.startsWith("approval/") || frame.method.startsWith("userInput/") ||
      (item && !nativeSearch && !["agentMessage", "reasoning", "userMessage"].includes(String(item.kind)))
    )) { this.fence(this.#stage ? "Muse staged replay attempted tool/helper activity; no replay" : "Muse raw completion emitted tool/helper activity"); return; }
    // Tool-free frames can precede the command response. Do not fold or
    // publish them before we know which turn was admitted. Refusals and
    // forbidden activity above still take effect synchronously.
    const submission = this.#submission;
    if ((this.#options.purpose === "raw" || this.#stage || nativeSearch) && submission && !submission.turnId &&
        !["turn/started", "session/closed", "view/gap"].includes(frame.method) && !frame.method.includes("snapshot")) {
      (submission.preIdentity ??= []).push(frame);
      return;
    }
    if ((this.#options.purpose === "raw" || this.#stage) && frame.method.startsWith("item/")) {
      const turnId = item?.turnId ?? params.turnId;
      if (typeof turnId === "string" && turnId !== this.#submission?.turnId) {
        this.fence("Muse tool-free item has foreign turn identity"); return;
      }
      if (this.#submission?.terminal) return; // Never buffer late transcript bytes into next chat turn.
    }
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
      this.#flushPreIdentity(this.#submission);
      if (this.#reason) return;
      this.#submission.admit?.();
    }
    if (item?.kind === "userMessage" && item.commandId !== this.#submission?.commandId && !this.#steers.has(String(item.commandId))) {
      this.fence("Unsolicited Muse user input"); return;
    }
    if (item?.kind === "toolCall" && !nativeSearch && !this.#tools.has(String(item.tool ?? item.toolName))) {
      this.fence("Undeclared Muse tool item"); return;
    }
    let search: NativeSearchEntry | undefined;
    if (nativeSearch) {
      if (this.#closing || submission?.terminal) return;
      if (!submission?.turnId || !this.#busy || item.turnId !== submission.turnId) {
        this.fence("Muse native search has foreign or inactive turn identity"); return;
      }
      search = this.#projectSearch(frame.method, item, submission);
      if (this.#reason) return;
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
      if (frame.method === "turn/completed") this.#submission!.terminal = true;
      if (!this.#reason && !this.#closing) {
        this.#emit({ kind: "frame", frame });
        if (search) this.#emit({ kind: "native-search", entry: search });
      }
      if (frame.method === "turn/completed") {
        if (policyDenial(params.error)) {
          this.fence(`Muse nonretryable provider refusal: ${JSON.stringify(params.error)}`);
        }
        if (this.#closing) {
          this.ledger.record("turn_terminal_during_close", { turnId: params.turnId, status: params.terminal });
          return;
        }
        const finish=()=>{
          if(this.#reason||this.#closing||this.#dead)return;
          this.#busy=false;
          this.#emit({kind:"terminal",turnId:String(params.turnId),status:params.terminal as "completed"|"cancelled"|"failed",frame,lastRetryHttpStatus:this.#lastRetryHttpStatus,lastRetryCause:this.#lastRetryCause});
        };
        // Do not release a completed coding turn (and permit a new auxiliary
        // host) until refresh metadata is known safe. No credential bytes read.
        if(this.#options.verifyLogin)void this.#options.verifyLogin().then(finish,error=>this.fence(String(error?.message??error)));
        else finish();
      }
    } catch { this.fence("Muse fold refused frame"); }
  }

  #projectSearch(method: string, item: Record<string, unknown>, submission: Submission): NativeSearchEntry | undefined {
    if (!["item/started", "item/updated", "item/completed"].includes(method)) return;
    const { callId, itemId } = item;
    if (typeof callId !== "string" || !callId || typeof itemId !== "string" || !itemId) {
      this.fence("Muse native search lacks call identity"); return;
    }
    const searches = submission.searches ??= new Map();
    const previous = searches.get(callId);
    const observedQuery = searchQuery(item.args);
    if (previous && (previous.itemId !== itemId || observedQuery !== null && previous.query !== null && previous.query !== observedQuery)) {
      this.fence("Muse native search identity changed"); return;
    }
    const query = observedQuery ?? previous?.query ?? null;
    const completed = method === "item/completed";
    if (previous?.completed || previous && !completed) {
      if (previous.query === null) previous.query = query;
      return;
    }
    searches.set(callId, {itemId, query, completed});
    const identity = {sessionId:this.sessionId, turnId:submission.turnId!, callId, query};
    if (!completed) return {...identity, phase:"started"};
    const status = item.status === "completed" || item.status === "failed" || item.status === "cancelled" ? item.status : "unknown";
    return {...identity, phase:"completed", status, sources:searchSources(item, query)};
  }

  #flushPreIdentity(submission: Submission): void {
    const held = submission.preIdentity;
    submission.preIdentity = undefined;
    for (const frame of held ?? []) {
      if (this.#closing || this.#reason) break;
      this.#apply(frame);
    }
  }

  #decide(request: MuseApproval): { choiceId: string } {
    let args: unknown;
    try { args = JSON.parse(request.rawArgs); } catch { args = undefined; }
    const scoped = !this.#stage && !this.#reason && !this.#dead && !this.#closing && this.#busy &&
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

  /** Measure against this native session and negotiated tier before any turn. */
  measureTurn(requestedEffort?:string) {
    const {tier:reasoningEffort} = resolveMuseEffort(requestedEffort,this.#options.catalogueEfforts,this.#options.model);
    const sessionId=this.sessionId, commandId=this.connection.mintCommandId();
    return (input:string|TurnInputPart[])=>turnStartFrameBytes({sessionId,input:inputParts(input),reasoningEffort,commandId});
  }

  async submitStage(input:TurnInputPart[], effort?:string, started?:()=>void):Promise<StagedTerminal> {
    if (this.#options.nativeSearch) throw new Error("Muse staged replay requires native search to be off; no stage was submitted.");
    if (this.#stage) throw new Error("Muse replay stage already pending");
    let complete!:(event:StagedTerminal)=>void,reject!:(error:Error)=>void;
    const terminal=new Promise<StagedTerminal>((yes,no)=>{complete=yes;reject=no;});
    this.#stage={complete,reject};
    const signal=this.#options.signal;
    const aborted=()=>reject(new Error("Request aborted"));
    signal?.addEventListener("abort",aborted,{once:true});
    if (signal?.aborted) aborted();
    try {
      const [ack,event]=await Promise.all([Promise.resolve().then(()=>{
        signal?.throwIfAborted();
        return this.submitInput(input,effort).then(ack => { started?.(); return ack; });
      }),terminal]);
      if (ack.turnId!==event.turnId) throw new Error("Muse staged replay terminal has foreign identity");
      return event;
    } finally {
      signal?.removeEventListener("abort",aborted);
      this.#stage=undefined;
    }
  }

  async submitInput(text: string | TurnInputPart[], requestedEffort?: string): Promise<{ turnId: string; commandId: string }> {
    const {tier:effort, resolution:effortResolution} = resolveMuseEffort(requestedEffort, this.#options.catalogueEfforts, this.#options.model);
    this.#assertLive();
    if (!this.#session) throw new Error("Muse session not open");
    if (!this.#emptyPending()) this.#assertLive();
    if (this.#busy) throw new Error("Muse predecessor has no turn/completed terminal");
    this.#submission = undefined;
    this.#retrySafe = true;
    const commandId = this.connection.mintCommandId();
    // Refuse an unreadable frame before anything is written or billed. A long
    // session that exceeds the client's inbound limit must name the size, the
    // limit and the next step instead of dying mid-work with "no replay".
    const input = inputParts(text);
    const frameBytes = turnStartFrameBytes({ sessionId: this.sessionId, commandId, input, reasoningEffort: effort });
    if (frameBytes > MUSE_INBOUND_FRAME_LIMIT_BYTES) throw new MuseFrameOverInboundLimit(frameBytes);
    await this.#options.verifyLogin?.();
    this.#assertLive();
    if (!this.#options.echo) {
      const result = await this.connection.request("usage/read", {}).catch(error=>{if(!this.#refusal(error) && quotaDenial(error))this.fence(quotaFenceMessage(error));throw error;});
      const usage = result.usage as any;
      if (hasQuotaData(usage)) {
        publishQuota(usage); this.ledger.quota(usage);
        // Muse reports percentages; 100% is the provider's exhausted plan boundary.
        if (quotaExhausted(usage)) {
          const resetIso = quotaExhaustedResetIso(usage);
          const msg = `Muse plan usage limit reached (quota exceeded); no turn submitted${resetIso ? ` (resets at ${resetIso})` : ""}`;
          this.fence(msg);
          throw new Error(msg);
        }
      }
    }
    this.#assertLive(); // Abort may have settled the preflight while it was awaiting I/O.
    const submission: Submission = { commandId, turnId: undefined, terminal: false, started: false };
    this.#submission = submission;
    this.#committedCalls.clear(); this.#committedBatches.clear(); this.#lastRetryHttpStatus=undefined; this.#lastRetryCause=undefined;
    this.#retrySafe = false;
    this.#busy = true;
    try {
      // Never Session.sendUserTurn: the SDK replay producer remains empty.
      const ack = await this.connection.command("turn/start", { sessionId: this.sessionId,
        input, reasoningEffort: effort }, { commandId, maxAttempts: 1 });
      this.#assertLive();
      if (ack.commandId !== commandId || ack.status !== "accepted" || (ack.disposition !== "started" && ack.disposition !== "queued") ||
        typeof ack.turnId !== "string" || (submission.turnId !== undefined && submission.turnId !== ack.turnId)) {
        throw new Error("Muse raw turn was unserved or mismatched");
      }
      submission.turnId = ack.turnId;
      this.ledger.record("turn_admitted", {
        commandId, turnId: ack.turnId, disposition: ack.disposition,
        requestedEffort: requestedEffort ?? null, submittedEffort: effort, effortResolution,
        acceptance: "native:MSP-turn/start;not-physical-provider-effort",
        images: (typeof text === "string" ? [] : text.filter(p => p.type === "image")).map(p => {
          const bytes = Buffer.from(p.base64Data!, "base64");
          return { mediaType: p.mediaType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        }),
      });
      this.#flushPreIdentity(submission);
      this.#assertLive();
      // MSP TurnStartDisposition: queue is the default when the host is busy.
      // Even just after turn/completed, dispatch may still be releasing its slot.
      // Admission is NOT execution: wait for this command's own turn/started.
      // No retry, SDK pending entry, timeout or additional turn/start is authored.
      if (ack.disposition === "queued" && !submission.started)
        await new Promise<void>((resolve, reject) => { submission.admit = resolve; submission.refuse = reject; });
      this.#assertLive();
      return { turnId: ack.turnId, commandId };
    } catch (error) {
      submission.preIdentity = undefined;
      // A correlated SDK error response to turn/start, not usage/read, a
      // notification, a local error, or a failed/unknown accepted turn. Capture
      // it before refusal handling fences the host and discards held events.
      const refused = error instanceof MspError && !submission.started && submission.turnId === undefined;
      if (refused) {
        const status = error.data.httpStatus;
        this.#emit({ kind: "admission-refused", ...(typeof status === "number" && Number.isInteger(status) ? {httpStatus:status} : {}) });
      }
      // The client's own inputTooLarge refusal is the frame limit measured above;
      // nothing was admitted, so report both numbers and leave the host usable.
      const limit = inputTooLarge(error);
      if (limit !== undefined) {
        this.#busy = false;
        throw new MuseFrameOverInboundLimit(frameBytes, limit);
      }
      this.#retrySafe = !policyDenial(error) && !quotaDenial(error) && !submission.started && submission.turnId===undefined && error instanceof MspError &&
        ((error.code===-32001 && error.kind==="overloaded") || (error.code===-32031 && error.kind==="backpressured"));
      this.#refusal(error);
      if (quotaDenial(error) && !policyDenial(error)) {
        this.ledger.record("quota_refusal", {phase:"turn_admission"});
        this.fence(quotaFenceMessage(error));
      } else if (refused && !this.#retrySafe) {
        // Pi recognizes retry/overflow hints in text. Do not pass an arbitrary
        // refusal message through that classifier as authority to resubmit.
        this.fence("Muse turn/start refused; no replay");
      } else if (!this.#closing || error instanceof MspError) this.fence(`Muse turn admission failed; no replay: ${error instanceof Error ? error.message : String(error)}`);
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
    }catch(error){if(!this.#refusal(error) && !this.#closing)this.fence("Muse steering failed; no replay");throw error;}
  }

  fence(reason: string): void {
    if (this.#reason) return;
    this.#reason = reason;
    this.ledger.retire("fenced", reason.split(":")[0].slice(0, 120));
    this.#submission?.refuse?.(new Error(reason));
    this.#emit({ kind: "fenced", reason });
    void this.close().catch(() => undefined);
  }

  hostExited(exit: ExitClassification | { kind: "transportEof" }): void {
    // Report BOTH exit and EOF; public Session.hostExited owns idempotence.
    this.ledger.record("process_exit",{exitKind:exit.kind});
    if (exit.kind === "cleanShutdown" && this.#closing) return;
    const death = exit.kind === "cleanShutdown" ? { kind: "transportEof" as const } : exit;
    this.#dead = true;
    this.#session?.hostExited(death);
    this.fence(`Muse host died; ephemeral lineage discarded (${JSON.stringify(exit)})`);
  }

  close(reason = "close"): Promise<void> {
    if (!this.#closePromise) {
      this.#closing = true;
      this.#stage?.reject(new Error("Muse closed during staged replay; no replay"));
      this.ledger.retire(reason);
      const submission = this.#submission;
      submission?.refuse?.(new Error("Muse closed while awaiting queued admission; no replay"));
      if (submission && !submission.terminal && !this.#retrySafe) {
        this.ledger.record("turn_retired", { commandId: submission.commandId, turnId: submission.turnId ?? null,
          admission: submission.turnId ? "identified" : "unknown" });
      }
      if (submission?.turnId && !submission.terminal && !this.#dead) {
        const { commandId, turnId } = submission;
        this.ledger.record("turn_cancel_requested", { commandId, turnId });
        // SDK close drains already-enqueued writes before EOF on a healthy
        // peer, and owns escalation/reaping. Never await a cancel response.
        void this.connection.command("turn/cancel", { sessionId: this.sessionId, turnId }, { maxAttempts: 1 })
          .catch(error=>{this.#refusal(error);});
      }
      this.#closePromise = Promise.resolve().then(async () => { await this.closeProcess(); });
    }
    return this.#closePromise;
  }
}

export async function discoverMuseCatalog(signal?: AbortSignal) {
  const launch=museLaunchOptions({cwd:process.cwd(),tools:["read"],promptMode:"none"});
  const root = await createVendorRoot("pi-muse-discovery-");
  const env = vendorProcessEnv(launch.env, root, "inherited");
  let handshake: ReturnType<typeof spawnMspConnection> | undefined;
  const abort = () => { void handshake?.close().catch(() => undefined); };
  try {
    await qualifyMuseVersion(launch.command, env, signal);
    await seedVendorCatalogue(launch.env, root);
    signal?.throwIfAborted();
    handshake = spawnMspConnection({...launch, env});
    signal?.addEventListener("abort", abort, {once:true});
    const spawned = await handshake.initialize({ clientInfo: { name: "pi_muse_tether", version: "0.2.0" },
      capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false } });
    const catalog = await spawned.connection.request("model/list", {});
    signal?.throwIfAborted();
    return catalog as typeof catalog & {models:any[]};
  } catch (error) {
    if (handshake && policyDenial(error)) policyLatch="Muse nonretryable provider refusal latched; account-owner review required";
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    try { await handshake?.close(); }
    finally { await rm(root, { recursive:true, force:true }); }
  }
}

export async function openMuseHost(options: MuseHostOptions): Promise<MuseHost> {
  let launch = museLaunchOptions(options); // preflight BEFORE filesystem/process work
  options = {...options, binary:launch.command, clientBuild:clientBuildLabel(launch.command)};
  options.signal?.throwIfAborted();
  const catalogueBefore = options.echo ? undefined : await catalogueIdentity(launch.command);
  // One canonical root owns vendor materialization, settings, trust, login
  // link and the raw/coding workspace. Inventory and serve see the same roots.
  const home = await createVendorRoot("pi-muse-host-");
  const env = vendorProcessEnv(launch.env, home, options.echo ? "echo" : options.privatePrompt ? "private" : "inherited");
  let verifyLogin:(()=>Promise<unknown>)|undefined, cleaned=false;
  let host: MuseHost | undefined;
  let handshake: ReturnType<typeof spawnMspConnection> | undefined;
  const abortOpen = () => { void (host ? host.close("abort") : handshake?.close())?.catch(() => undefined); };
  const cleanup=async()=>{
    if(cleaned)return;cleaned=true;
    if(verifyLogin)await verifyLogin();
    // If verification throws, preserve the private metadata file and stop. Never
    // delete a possible rotated credential or repair the account owner's login automatically.
    await rm(home,{recursive:true,force:true});
  };
  try {
    const versions = await qualifyMuseVersion(launch.command, env, options.signal);
    options={...options,clientBuild:clientBuildLabel(launch.command)};
    if (options.qualificationProbe && !process.env.PI_MUSE_TETHER_QUALIFICATION_REAL_CONFIG) throw new Error("Qualification probe requires the isolated opt-in worker");
    let batchReason:string|undefined;
    if (options.toolBatches && !options.echo && !options.qualificationProbe) {
      let eligible;
      try { eligible=batchEligibility(launch.command); } catch { eligible={qualified:false,reason:"Qualification schema/identity check unavailable"}; }
      if (!eligible.qualified) { batchReason=eligible.reason; options={...options,toolBatches:false}; }
    }
    if (!options.toolBatches && !options.echo) launch = {...launch, args:[...(launch.args ?? []), "--config", "run.parallel_tool_calls=false"]};
    if (options.privatePrompt) {
      await writePromptSettings(home, options.privatePrompt.systemPrompt, options.tools, options.privatePrompt.skillsOff, options.promptMode === "append" ? "append" : "replace", options.nativeSearch);
      options = {...options, privateWorkspace: privateWorkspace(home)};
      if(!options.echo){
        const verify=await linkHostLogin(home,launch.env?.XDG_CONFIG_HOME??join(homedir(),".config"));
        verifyLogin=async()=>{
          const metadata=await verify();
          if(metadata.realMetadataChanged)host?.ledger.record("auth_metadata_change",{metadata});
          options.onEvent?.({kind:"auth-metadata",metadata});
          return metadata;
        };
      }
      const skills=options.privatePrompt.skillsOff??await discoverSkillsOff(launch.command,options.cwd,env,options.signal);
      // Inventory is finished before the model host starts. Only this generation
      // can see this settings path; auxiliary summaries stage their own files.
      const pi = privatePiMcp(options);
      const settings = promptSettings(options.privatePrompt.systemPrompt,options.tools,skills,options.promptMode === "append" ? "append" : "replace", options.nativeSearch);
      await writeFile(join(home,"config/muse/settings.json"),JSON.stringify({
        ...settings, ...(pi ? {mcp_servers:{pi}} : {}),
      }),{mode:0o600});
    }
    options.signal?.throwIfAborted();
    handshake = spawnMspConnection({ ...launch, env });
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
    const spawned = await handshake.initialize({ clientInfo: { name: "pi_muse_tether", version: "0.2.0" },
      capabilities: { requestedCapabilities: ["sessionMcp",...(options.toolBatches?["rawLog"]:[])], userInputDialogs: false, ...((options.privatePrompt||options.toolBatches||Object.keys(options.mcpServers??{}).length)?{experimentalApi:true}:{}) } });
    if (options.nativeSearch && spawned.initializeResult.experimentalApi !== true)
      throw new Error("Muse native search requires experimental MSP search projection; no prompt was sent.");
    if (options.privatePrompt && options.promptMode === "replace" && spawned.initializeResult.experimentalApi === false) {
      if (options.purpose === "raw") throw new MuseFeatureUnavailable(options.clientBuild ?? "unknown build","privatePrompt","tool-free request requires qualified prompt replacement; no append fallback");
      await spawned.close(); await cleanup();
      const build = options.clientBuild ?? "unknown build", reason = "experimental private replacement not negotiated",
        fallback = "Pi prompt appended through supported run.developer_prompt, not replacing Muse instructions";
      featureNotice(build,"privatePrompt",reason,fallback);
      const appendHost = await openMuseHost({...options,promptMode:"append"});
      appendHost.ledger.record("route_degraded",{build,feature:"privatePrompt",reason,fallback});
      return appendHost;
    }
    if (options.privatePrompt && options.promptMode === "replace") featureActive(options.clientBuild ?? "unknown build","privatePrompt");
    if (!spawned.initializeResult.grantedCapabilities.includes("sessionMcp")) throw new MuseFeatureUnavailable(options.clientBuild ?? "unknown build","sessionMcp","initialize did not grant session MCP");
    if(options.toolBatches && !spawned.initializeResult.grantedCapabilities.includes("rawLog")) {
      batchReason="rawLog not granted";
      options = {...options, toolBatches:false};
    }
    if (!options.echo) {
      const catalog = await spawned.connection.request("model/list", {});
      await refreshCatalogueFromHost(catalogueBefore,launch.command,catalog);
      const selected = museCatalogAssessment(catalog).valid.find((m) => m.modelId === options.model);
      if (!selected) throw new Error("Selected usable model absent from official Muse model/list providerCatalog");
      options = {...options, catalogueEfforts: [...selected.variants]};
    }
    host = new MuseHost(spawned.connection, spawned.initializeResult, {...options,verifyLogin}, async () => {
      try { await spawned.close(); } finally { await cleanup(); }
    });
    host.ledger.record("client_route",{build:options.clientBuild,...versions,
      versionPolicy:isNewerThanTestedCli(versions.client) ? "continuing, not yet qualified" : "within tested version range",
      promptMode:options.promptMode, toolMode:host.batches ? "parallel" : "sequential"});
    if (batchReason) host.degradeBatches(batchReason);
    else if (host.batches) featureActive(options.clientBuild ?? "unknown build","rawLog");
    void spawned.child.exit.then((exit) => host!.hostExited(exit));
    // These pre-open frames cannot belong to a newly created root session.
    held.length = 0;
    return await host.open();
  } catch (error) {
    if(handshake && policyDenial(error))policyLatch="Muse nonretryable provider refusal latched; account-owner review required";
    await (host ? host.close() : handshake?.close())?.catch(() => undefined);
    await cleanup();
    if (handshake && serverRequiresUpgrade(error)) throw new MuseUpgradeRequired(options.clientBuild ?? clientBuildLabel(launch.command));
    throw error;
  } finally { options.signal?.removeEventListener("abort", abortOpen); }
}
