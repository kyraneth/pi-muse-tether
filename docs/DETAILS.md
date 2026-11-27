# Technical details

Use Muse Code models in [Pi](https://github.com/earendil-works/pi) through the official Muse Code subscription client. Pi owns tools, permissions, canonical history, steering, cancellation and compaction; Muse supplies inference. This is an independently developed integration, not an official Muse or Meta product.

## Install and first use

Requires Node.js 24+, Pi 1.5.0, the official Muse Code client, and an account entitled to the selected model. Qualified builds are 1.4.14-R7309.1 and 1.4.15-R8339.1 for private prompt settings, session MCP and experimental rawLog committed tool batches. The 1.4.15 qualification includes asynchronous MCP readiness and an Ember tool-batch workload; it does not establish equal workload coverage for every model. The adapter independently pins `@muse-code/sdk` 1.4.14. Newer clients warn (strict mode refuses only when explicitly enabled). Unqualified builds run sequential tools; parallel-tool qualification is hash-bound data plus capability negotiation and runtime schema validation, not a whole-turn exact-build gate.

```sh
pi install npm:pi-muse-tether
PI_MUSE_TETHER_LIVE=1 pi --provider pi-muse-tether --model muse-spark-1.3
```

Install and sign in to the official Muse Code client separately using its own instructions. The default binary is `~/.local/bin/muse`; override it with `PI_MUSE_TETHER_BINARY`. The tether links existing official login metadata into a private host configuration, without reading, printing or copying its body. It does not modify your ordinary client settings or provide a separate login command. It refuses replaced links and unsafe permissions rather than repairing credentials automatically. An ordinary official-client refresh is distinguished from replacing the link. Account health and entitlement are not guaranteed by local diagnostics.

Without `PI_MUSE_TETHER_LIVE=1`, only the synthetic offline `echo` model is registered. `/muse-doctor` reports local version/recipe/telemetry diagnostics without an account or model request.

## Choose a model

The live `model/list` catalog supplies windows, output limits, image capability and supported effort levels. Valid provider-catalog models register independently; missing or invalid rows are omitted, with no guessed model entry. An authoritative empty provider catalogue removes live picker rows. Bundled or failed discovery keeps the last valid same-identity rows, labelled stale; it never authorizes a turn. The offline echo remains available, and `/muse-doctor refresh` requests an explicit provider refresh.

| Pi model ID | Selection |
| --- | --- |
| `muse-spark-1.3` | Spark 1.3 Contributor (legacy alias) |
| `muse-spark-1.3-contributor` | Spark 1.3 Contributor (same recipe) |
| `muse-wonder-1.0` | Wonder default mode |
| `muse-wonder-1.0-contributor` | Wonder contributor mode |
| `muse-wonder-full-1.0` | Wonder Full default mode |
| `muse-wonder-full-1.0-contributor` | Wonder Full contributor mode |

Contributor mode is a **model choice**, not an integration caveat. Spark 1.3 has two IDs for one contributor recipe; Spark 1.2 and Wonder expose separate Normal and Contributor choices. The logical selector and derived response identity are not independently observed physical-backend telemetry. Spark has the broader live qualification history; catalog/loader coverage of Wonder does not establish equal workload qualification.

The running Pi’s built-in Meta catalogue supplies API rates and image resize metadata for the exact recipe, if present. Missing tables stay unknown (for example, unlisted Wonder contributor recipes); missing counters can make an estimate partial. The request ledger’s `referenceCost` is calculated once per distinct MSP usage record, using that record's input total (uncached plus cache reads and writes) for any price tier. Pi messages sum those estimates; native cumulative cost is shown separately and not added. Context totals are the last reported occupancy, not cumulative spend. These estimates are neither a subscription invoice nor proof of the cost of every physical attempt. Pi still owns image normalization and the user’s auto-resize setting.

## Configuration and prompt ownership

| Setting | Meaning |
| --- | --- |
| `PI_MUSE_TETHER_LIVE=1` | Explicitly enable live catalog discovery and model use |
| `PI_MUSE_TETHER_BINARY=/path/to/muse` | Choose the official executable |
| `PI_MUSE_TETHER_SYSTEM_PROMPT=replace` | Default live mode: exact Pi instructions in private `run.system_prompt` settings |
| `PI_MUSE_TETHER_SYSTEM_PROMPT=none` | Legacy no-Pi-prompt mode; disables raw summaries |
| `XDG_STATE_HOME` | Base directory for best-effort metadata ledger diagnostics |

Prompt replacement uses private settings with explicit workspaceRoot, not a public per-turn prompt API. If experimental replacement is not negotiated, the host reopens before submitting a turn with the supported `run.developer_prompt` mechanism: Pi’s instructions are appended to Muse’s, not replacing them, with a typed notice. Only the current Pi MCP toolset is enabled; inventory-derived skills, named reminders and workflow triggers are disabled. Missing session MCP refuses with build and cause; there is no vendor-tool fallback. Developer workspace, permissions and memory context remain: this is **not a vendor-free prompt**. Universal reminder suppression lacks an enabled-reminder positive control.

Muse sees names such as `mcp__pi__read`; Pi's actual names, schemas and execution remain unchanged. The private configuration requests Ask-me permissions and verifies human-reviewer readback, avoiding an extra automatic approval-judge request. This does not make Pi tools read-only.

## Provider hooks

Pi's `before_provider_request` sees the logical Muse request (`systemPrompt`, `messages`, `tools`, `transport`), not an HTTP body. The default first tool description already contains the transport loss notice. The tether validates the hook's final declarations and projects them into MCP without adding the notice again; removing or editing a tool has the same effect on the broker. The notice does not alter the system prompt or the ledger's loss accounting.

`after_provider_response` reports logical admission (`x-pi-tether-response: logical-admission`) with status `0` (non-HTTP). A typed SDK rejection of `turn/start` before admission reports `logical-refusal` with `data.httpStatus` if the SDK supplied it, otherwise `0`. `x-pi-tether-transport: official-muse-client` and the response headers are local adapter metadata, not an upstream HTTP response. Fencing and discarding held work happen immediately; the refusal's terminal error waits for the observer. A failing observer cannot override the refusal. There is no synthetic response for local checks (including quota sampled before submission), transport loss or uncertain sends, and no second response for a failure after admission. Callers that do not supply these Pi callbacks, such as some compaction paths, do not emit these hook events.

## History and compaction

Completed turns can reuse one ephemeral host while model, prompt, tools, working directory, owner and acknowledged history prefix match. Changed completed context imports the selected Pi branch as ordered inert JSON, not API-role replay. Historical calls are not dispatched; unresolved calls stay unresolved; thinking is omitted. Supported user images retain block references. Unsupported media refuses. A newly proposed action can still semantically duplicate an earlier action: there is no exactly-once semantic guarantee.

**Imported frame limit:** the official client refuses a single inbound message above 10,485,760 bytes (10 MiB), measured on 1.4.14/1.4.15. The tether counts the actual JSON line (including escaped text, IDs, delimiters and base64). If the original fits it is submitted once unchanged. Otherwise the entire replay is planned first: ordered history and intact historical images move to acknowledged stages, while the whole current request or Pi summary directive stays in the last frame. Stages run on the same temporary session with Pi tools detached; a native tool, helper, gap or interruption during a stage ends the plan without replay. The request ledger correlates stage and final usage by plan ID; Pi sees only the final response and usage. Stages add inference work and consume native context: they are not a larger context window. Indivisible oversize produces a byte-size error before any model turn, while a genuine model-window overflow still follows Pi's recovery path.

**Restart/cache limitation:** restarting Pi or Muse can require a cold full-history request. Some warm requests also miss cache. Cache key, scope and TTL remain unknown; no billed keepalive or cache-miss replay is used. Keeping a Muse host alive across Pi restarts is not implemented, and saving a vendor session alone is not a demonstrated cache fix.

Tool-free turns use an empty native toolset and no MCP bridge. They stream visible text and supported reasoning summaries, preserving multipart input and reconciling each streamed item with its committed text. Exact appends to the active Pi journal can reuse a completed host; changed history or instructions require a fresh projection. Ambiguous, anonymous and standalone summary calls always use separate ephemeral hosts. Unverified completion (including tool/helper activity, mismatched text or missing native input/output usage) fails without retiring an unrelated coding binding. Only committed Pi compaction retires it. Pi owns thresholds, persistence and re-import; there is no vendor compact command or fabricated summary.

For a desired 450,000-token compaction boundary, calculate `reserveTokens = actual catalog contextWindow - 450000`. For example, at a catalog window of 1,007,997 the reserve is 557,997. Configure the corresponding model override in your Pi settings; do not alter catalog windows or prices. Pi checks strict `>` at tool-batch boundaries, so this is not an absolute billed-input cap. Controlled native integration covers threshold/overflow continuation; it is not a live 450k stress qualification. The tether adds no workload timeout.

## Named limitations and failure behavior

### Parallel tools, long tools, abort and steering

Parallel coding requires matching qualification evidence, the experimental `rawLog` grant, a `session.live` subscription and schema-checked `assistant_tool_calls_committed` boundaries. Unknown builds, missing support, gaps or shape mismatches degrade to sequential tools with one notice, without timers, replay or client substitution. Concurrent native MCP calls queue and are verified one at a time. A degradation also releases approvals waiting on a lost boundary, so fallback cannot strand the turn. One Pi assistant contains the ordered tool batch; Pi validates/coerces its original arguments and journals validation errors or execution results before native approvals are released for exact receipt retrieval. Invalid arguments therefore produce the normal Pi validation message, not an opaque native approval denial. Native/MCP identity still binds the unchanged original arguments, including when Pi coerces them for execution. Raw records are consumed in memory, not logged wholesale.

**Long-tool limit:** Muse defaults to 300 seconds per MCP call. Its [documented `tool_timeout_sec`](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/mcp-servers/) is available in settings, not in MSP's `SessionMcpServerConfig`. The tether stages only the required Pi broker in the ephemeral host's private settings and gives it the same one-hour budget as the Claude tether. Each host still owns one session and one Pi broker; inventory and approvals remain bound to that session. No personal Muse settings are changed. Pi's own cancellation and tool-specific deadlines still apply. If a native timeout occurs, Muse consumes it for that call and continues; Pi can journal its late result, but the tether records the divergence as declared-lossy and never replays it. On qualified batch builds the approval hold still avoids opening the native call until Pi has journaled the result.

Abort propagates Pi's signal, retires the host/bridge and retains emitted content and effects; no warm reuse after abort is promised. Steering uses Pi's queue and journals results before continuation. Scripted probes cover stream/tool/approval races, not every interactive TUI race or a long-tool abort.

### Vendor retries

Each authored SDK command is sent once by the tether, but Muse may retry transient/server model failures inside the same turn before Pi sees an answer. Pi's retry setting cannot prevent those attempts. Retry notifications are not extra known billable completions. Refusal, auth, quota, policy and attestation checks stop first. The vendor's retry kind and HTTP status are optional open-vocabulary fields, so an unknown or missing kind is reported with the recorded cause instead of ending a live turn, and exhaustion preserves the HTTP status. An uncertain Pi retry refuses without new admission. Only known nothing-admitted overloaded/backpressured SDK errors allow an ordinary subsequent attempt.

No pinned SDK per-turn disable-retry control is qualified. Startup retry settings have been observed in offline surfaces but effective loading and zero-retry semantics remain unproved; they are not applied by this tether.

### Redaction and result shape

Muse receipts can replace secret-like text, including source-code token prefixes, with `[REDACTED]`. **What the model actually consumed is unknown.** No supported disable-redaction control was found in the inspected pinned surfaces, and no encoding/reflow bypass is used.

Declared redaction needs at least one positional alignment with nonempty single-line holes. Line-start, line-end and whole-line loss continue as declared-lossy; adjacent markers form one combined region, without claiming an internal split. Ambiguous alignments also continue: evidence records all viable start/end boundaries and the covering source range, explicitly marked ambiguous rather than inventing an exact removal. If that region swallows literal source markers their identity is likewise uncertain; unchanged literal markers alone never declare loss. The pinned client also canonicalizes a case-insensitive `bearer ` prefix to `Bearer ` immediately before a redaction. That narrowly located codec transformation is separately hashed and declared, not treated as permission to normalize arbitrary text. Newline removal, impossible alignment, changed text outside the declared regions, status changes and image metadata changes still fence. Surrounding bytes are verified, not bytes inside holes or whether they were secrets. Ledger rows link native/Pi call IDs, journal entry, tool/source path and original part byte ranges; ambiguous ranges retain candidate boundaries. Diagnostics contain offsets, lengths and hashes, never removed text. `exactModelConsumption:false` never attests consumption of the original bytes.

**Native empty-part projection:** successful results fold chunks with LF only after accumulated nonempty output, so leading empty parts add no separator while later empty parts do. An entirely empty success has the exact native display sentinel `[MCP tool returned no content]`. Failed results instead LF-join all text parts (including leading empty text), omit images, and use `MCP tool returned an error` if their joined text is empty. These are pinned-client receipt codecs, not global text cleanup.

**Image/multipart tool outputs (0.1.1):** PNG, JPEG, GIF and WebP are forwarded in arbitrary text/image layouts, including image-only, multiple images, empty text and errors. Receipt verification constructs the native ordered projection positionally; literal placeholder-shaped text and leading newlines are not stripped. Image metadata is declared-lossy, never exact pixel evidence; available `modelVisibleContent` derivatives do not upgrade that evidence. Truncated text still requires verified complete `item/readOutput` readback. Malformed encodings and genuine text/metadata mismatches still stop.

**Observed vendor limits:** the official failed-MCP path exposes only text (`failureReason`) and drops images from its receipt/model view. These images are explicitly marked `modelVisibility: omitted-error-result`, not claimed seen. A six-image live probe continued and read initial PNG/JPEG correctly, but reported GIF/WebP not visibly rendered and misidentified its last JPEG. Thus GIF/WebP transport acceptance and no-turn-failure are qualified, not their pixels or universal multi-image accuracy. A separate interleaved PNG/JPEG live probe read both images correctly. No format conversion or byte-equality claim is invented.

### Quota, usage and accounting

Native percentage/reset telemetry may initially be absent. Rounded 0% is not proof of no consumption, and other traffic shares the allowance. Real 403/account refusals stop; the tether does not route around entitlement. Only one account was qualified, not multi-account scaling or isolation. Native counter conventions are retained without counting cache twice. The ledger is best-effort metadata, not a complete physical-attempt or subscription billing audit. No valid cross-route latency comparison or cache-lifetime guarantee is claimed.

### Empty catalog over some IPv6 paths

If `/muse-doctor` reports an empty catalog, compare the official client alone:

```sh
muse exec --model muse-spark-1.3 "hi"
```

This command makes a real model request. If it says `does not exist or you lack access`, investigate entitlement and network reachability before blaming the adapter. Some datacenter IPv6 egress paths have returned empty catalogs/404s while the same account and host worked over IPv4; other IPv6 networks worked normally. This is not proof every empty catalog is a networking problem. A network administrator can make the affected IPv6 destination unreachable to permit official-client IPv4 fallback. Such routing changes affect the machine and should be diagnosed and approved separately. System-wide address preference and SOCKS environment variables were not effective in the observed client. The tether does not change routes or bypass access controls.

## Development and verification

The published manifest deliberately declares the exact registry dependency `pi-tether-core: "0.1.0"`, never a local file path. For development against the core repository's main branch before that registry release:

```sh
# Supply your authorized Git SSH URL; no credentials in the URL.
CORE_GIT_REMOTE=ssh://git@git.example.invalid/owner/pi-tether-core.git npm run dev:install-core
npm test
npm run export:manifest
npm run scan:public
npm pack --dry-run --json
```

The development script clones main, records its exact commit and tarball SHA-256, packs it, then installs that tarball with `--no-save --package-lock=false`. It also installs root test dependencies and never rewrites the registry declaration. Normal released development can use `npm install` at repository root. There is no workspace or sibling-repository requirement.

`npm test` runs offline Vitest coverage and Node tests, including the real Pi loader and official echo transport without live Muse inference. Public fixtures are hand-written synthetic fixtures authored for the tests; they contain no captured vendor output. Synthetic tests prove contracts, not fresh vendor parity. Export is an explicit allowlist. Internal qualification records, old scripts and cross-integration evidence are excluded. On an exported checkout without that policy, generic checks still run and the result explicitly reports `policyApplied:false`; this is not equivalent to the private-policy scan. No install, test or packaging command publishes or changes a production Pi installation.

## License

MIT. The license covers this adapter, not third-party clients, subscriptions or service terms.

## How I measured

The comparison in the README comes from two real coding tasks, run once through the tether and once through Pi's built-in Muse API provider, both on Pi 1.5.0. The tether used Muse Code 1.4.14 with a build from just before this release. Each route ran on its own, so model behaviour differed between them, and one run per route can't show how much the numbers vary.

Cache percentages are input tokens read from cache divided by all input tokens, using the counters each route reports. Turns 2 to 5 are the warm turns after the first request. Tools run by Pi counts the tool executions in Pi's own session records. The resume row is the first request after restarting Pi on the same session.
