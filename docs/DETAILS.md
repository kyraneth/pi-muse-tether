# Technical details

Use Muse Code models in [Pi](https://github.com/earendil-works/pi) through the official Muse Code subscription client. Pi owns tools, permissions, canonical history, steering, cancellation and compaction; Muse supplies inference. This is an independently developed integration, not an official Muse or Meta product.

## Install and first use

Requires Node.js 24+, Pi 1.5.0, the official Muse Code 1.4.14 client (qualified build R7309.1), and an account entitled to the selected model. The adapter pins `@muse-code/sdk` 1.4.14. Other versions are not qualified and may be refused.

```sh
pi install npm:pi-muse-tether
PI_MUSE_TETHER_LIVE=1 pi --provider pi-muse-tether --model muse-spark-1.3
```

Install and sign in to the official Muse Code client separately using its own instructions. The default binary is `~/.local/bin/muse`; override it with `PI_MUSE_TETHER_BINARY`. The tether links existing official login metadata into a private host configuration, without reading, printing or copying its body. It does not modify your ordinary client settings or provide a separate login command. It refuses replaced links and unsafe permissions rather than repairing credentials automatically. An ordinary official-client refresh is distinguished from replacing the link. Account health and entitlement are not guaranteed by local diagnostics.

Without `PI_MUSE_TETHER_LIVE=1`, only the synthetic offline `echo` model is registered. `/muse-doctor` reports local version/recipe/telemetry diagnostics without an account or model request.

## Choose a model

The live `model/list` catalog supplies windows, output limits, image capability and supported effort levels. Required missing models, unknown limits, empty catalogs and bundled fallback catalogs fail before inference; there is no guessed model entry.

| Pi model ID | Selection |
| --- | --- |
| `muse-spark-1.3` | Spark 1.3 contributor recipe |
| `muse-wonder-1.0` | Wonder default mode |
| `muse-wonder-1.0-contributor` | Wonder contributor mode |
| `muse-wonder-full-1.0` | Wonder Full default mode |
| `muse-wonder-full-1.0-contributor` | Wonder Full contributor mode |

Contributor mode is a **model choice**, not an integration caveat. Select it in Pi like any other model. Spark uses the fixed contributor recipe; Wonder exposes both choices. Wonder pricing is unknown and is displayed as such, not as zero. Spark's API-table reference prices are not subscription charges. The logical selector and derived response identity are not independently observed physical-backend telemetry. Spark has the broader live qualification history; catalog/loader coverage of Wonder does not establish equal workload qualification.

## Configuration and prompt ownership

| Setting | Meaning |
| --- | --- |
| `PI_MUSE_TETHER_LIVE=1` | Explicitly enable live catalog discovery and model use |
| `PI_MUSE_TETHER_BINARY=/path/to/muse` | Choose the official executable |
| `PI_MUSE_TETHER_SYSTEM_PROMPT=replace` | Default live mode: exact Pi instructions in private `run.system_prompt` settings |
| `PI_MUSE_TETHER_SYSTEM_PROMPT=none` | Legacy no-Pi-prompt mode; disables raw summaries |
| `XDG_STATE_HOME` | Base directory for best-effort metadata ledger diagnostics |

Append prompt mode is unsupported. Prompt replacement uses a version-qualified private settings route with explicit workspaceRoot, not a public per-turn prompt API. Only the current Pi MCP toolset is enabled; inventory-derived skills, named reminders and workflow triggers are disabled. Configuration failures never fall back to vendor defaults. Developer workspace, permissions and memory context remain: this is **not a vendor-free prompt**. Universal reminder suppression lacks an enabled-reminder positive control.

Muse sees names such as `mcp__pi__read`; Pi's actual names, schemas and execution remain unchanged. The private configuration requests Ask-me permissions and verifies human-reviewer readback, avoiding an extra automatic approval-judge request. This does not make Pi tools read-only.

## History and compaction

Completed turns can reuse one ephemeral host while model, prompt, tools, working directory, owner and acknowledged history prefix match. Changed completed context imports the selected Pi branch as ordered inert JSON, not API-role replay. Historical calls are not dispatched; unresolved calls stay unresolved; thinking is omitted. Supported user images retain block references. Unsupported media refuses. A newly proposed action can still semantically duplicate an earlier action: there is no exactly-once semantic guarantee.

**Restart/cache limitation:** restarting Pi or Muse can require a cold full-history request. Some warm requests also miss cache. Cache key, scope and TTL remain unknown; no billed keepalive or cache-miss replay is used. Keeping a Muse host alive across Pi restarts is not implemented, and saving a vendor session alone is not a demonstrated cache fix.

Raw summaries use separate ephemeral owners, no tools/MCP, one nonempty text assistant and native usage. Unexpected helpers/tools, multiple messages, failures or missing usage reject the summary without retiring the coding binding. Only committed Pi compaction retires it. Pi owns thresholds, persistence and re-import; there is no vendor compact command or fabricated summary.

For a desired 450,000-token compaction boundary, calculate `reserveTokens = actual catalog contextWindow - 450000`. For example, at a catalog window of 1,007,997 the reserve is 557,997. Configure the corresponding model override in your Pi settings; do not alter catalog windows or prices. Pi checks strict `>` at tool-batch boundaries, so this is not an absolute billed-input cap. Controlled native integration covers threshold/overflow continuation; it is not a live 450k stress qualification. The tether adds no workload timeout.

## Named limitations and failure behavior

### Parallel tools, long tools, abort and steering

Coding requires the pinned experimental `rawLog` capability, `session.live` subscription and complete `assistant_tool_calls_committed` boundary. Missing support fails before inference, without timers or single-call fallbacks. One Pi assistant contains the ordered tool batch; Pi executes approved tools and journals all results before native approvals are released for exact receipt retrieval. Raw records are consumed in memory, not logged wholesale.

**Long-tool limit:** a historical native MCP task timed out around 300 seconds while Pi was still running. Approval holding now avoids opening that native call during Pi execution. One synthetic 301-second live tool passed with the native MCP call open only briefly. That establishes the measured interval, **not unlimited approval patience or arbitrary long-build support**. No vendor no-deadline control is qualified. A late denial, timeout or host death can leave a real Pi side effect without a verified native receipt. Fencing cannot undo it or silently kill Pi's executor. Inspect uncertain effects before a new request; unknown work is never automatically replayed.

Abort propagates Pi's signal, retires the host/bridge and retains emitted content and effects; no warm reuse after abort is promised. Steering uses Pi's queue and journals results before continuation. Scripted probes cover stream/tool/approval races, not every interactive TUI race or a long-tool abort.

### Vendor retries

Each authored SDK command is sent once by the tether, but Muse may retry transient/server model failures inside the same turn before Pi sees an answer. Pi's retry setting cannot prevent those attempts. Retry notifications are not extra known billable completions. Refusal, auth, quota, policy and attestation checks stop first; unknown retry kinds fail closed and exhaustion preserves HTTP status. An uncertain Pi retry refuses without new admission. Only known nothing-admitted overloaded/backpressured SDK errors allow an ordinary subsequent attempt.

No pinned SDK per-turn disable-retry control is qualified. Startup retry settings have been observed in offline surfaces but effective loading and zero-retry semantics remain unproved; they are not applied by this tether.

### Redaction and result shape

Muse receipts can replace secret-like text, including source-code token prefixes, with `[REDACTED]`. **What the model actually consumed is unknown.** No supported disable-redaction control was found in the inspected pinned surfaces, and no encoding/reflow bypass is used.

Accepted redaction needs nonempty single-line removed text, exact nonempty context on both sides and one unambiguous alignment. Literal markers remain literal. Line-edge, whole-line, adjacent or ambiguous loss stops. Surrounding bytes are verified, not bytes inside holes or whether those bytes were secrets. Metadata diagnostics retain offsets, lengths and hashes, never removed text. `exactModelConsumption:false` means absence of proof, not proof that input was altered.

**Image/multipart tool-output limitation:** general ordered-part and pixel delivery remain unqualified. The verifier supports narrow text-list joins and declared-unverifiable image placeholders; placeholder metadata and hash reporting do not prove model consumption. Invalid/unqualified layouts fail before batch delivery. This differs from working user-image input/history. A simple current/imported 256×256 image probe does not establish general visual accuracy.

### Quota, usage and accounting

Native percentage/reset telemetry may initially be absent. Rounded 0% is not proof of no consumption, and other traffic shares the allowance. Real 403/account refusals stop; the tether does not route around entitlement. Only one account was qualified, not multi-account scaling or isolation. Native counter conventions are retained without counting cache twice. The ledger is best-effort metadata, not a complete physical-attempt or subscription billing audit. No valid cross-route latency comparison or cache-lifetime guarantee is claimed.

### Empty catalog over some IPv6 paths

If startup says `Muse catalogue cannot register required live models` with an empty list, compare the official client alone:

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
