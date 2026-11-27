# Changelog

## 0.2.7

- Opt in to Muse's native web search with `PI_MUSE_TETHER_NATIVE_SEARCH=1`. Pi announces the opt-in once per session and shows the queries and sources Muse reports. Search is off by default and refused in strict mode.
- Keep normal starts and turns quiet. Client version and fallback details are available in the request ledger and `/muse-doctor`. Pi still shows refused turns, rate and quota limits, discovery failures that leave no live models, and history replay when it starts.
- Isolated tests now tolerate unrelated live requests being appended to the ledger while still catching test writes and changes to existing rows.

## 0.2.6 — 2026-11-25

- Restore live Muse models on a cold Pi start and show discovery failures in the model list command.

## 0.2.5 — 2026-11-25

- Reuse the Muse model list across Pi starts and refresh it when needed, rather than after every run.
- Choose the default reasoning effort from the selected model’s advertised options and restore parallel tool calls on Muse Code 1.4.25.
- Stream replies on turns without tools. Stage large conversation histories across background turns when they cannot fit in one request to the Muse client.
- Run with read-only Muse data directories and avoid reporting an interrupted request during normal shutdown.
- Show the estimated API cost for the selected model and reasoning effort, separately from subscription billing. Notify Pi response hooks when Muse refuses to accept a request.

## 0.2.4 — 2026-11-24

- Tool results containing images now work with Muse Code 1.4.25, which includes image dimensions in its placeholder text.

## 0.2.3 — 2026-11-23

- Tests now refuse to write to the real request ledger, even when a test path points to it indirectly.
- Temporary rate limits no longer stop the client from retrying. Quota errors show the reset time when available, and empty usage events are ignored.
- Oversized sets of allowed values in tool schemas are rejected before sending. A response that skips required structured output now reports the failure without discarding its text, and retry messages show the cause when available.

## 0.2.2 — 2026-11-20

- A turn whose frame is over the official Muse client's 10,485,760-byte inbound limit is refused before sending instead of ending the session: the error names the measured frame size, the limit and its source, and Pi's normal overflow recovery compacts the history and retries once. Long sessions with base64 images therefore continue rather than dying mid-work.
- A retry notification with an unknown or missing vendor `errorKind` is no longer fatal: the live turn continues and its status line shows the recorded cause, system and HTTP status instead of `undefined`. Observed real Wonder Full retries sent no kind and no status at all. A retry the vendor sends with no `errorKind` is honoured when this turn already saw a 5xx.
- Pi tools have a one-hour deadline in the private Muse host instead of hitting Muse's default five-minute tool deadline. A native timeout still settles only that call, not the whole turn. Muse consumes a timeout result and continues; Pi's late result stays journaled in Pi and is never replayed to Muse. The divergence is ledger-recorded with `exactModelConsumption:false`. Approval-hold behavior for native timeouts during held approvals is unchanged.
- A failed catalogue discovery no longer replaces the working catalogue with an empty one: the turn warns with the cause, the catalogue in use is kept so `/model` keeps working, and `/muse-doctor` reports the failure.
- Add `/muse-doctor ledger`: counts live rows only, splits them by event type and requested model, and reports every excluded row with its reason (test, proof, pre-0.2.1 rows without `origin`, unreadable lines).

## 0.2.1

- Follow the official auto-updating Muse client; unknown builds run sequential Pi tools instead of refusing all turns. Parallel tools use qualification records, negotiated rawLog and runtime schema checks.
- Add per-feature typed degradation/refusal, private-prompt append fallback and actionable catalogue-disabled diagnostics.
- Add `/muse-doctor qualify [build] [--live]`, isolated conformance/explicit live suites and hash-bound qualification records.
- Isolate Vitest, node:test and native proofs from production client/state/ledger; stamp ledger origin and package version; guard full test/proof runs with before/after hashes, including qualification records.
- Wait for session-MCP readiness in official echo conformance before asserting request configuration. Run both test phases even if one fails, retaining per-test output; version-only diagnostic probes use temporary HOME/XDG roots.
- Ledger origin/version stamps distinguish isolated tests from production observations; historical fixture counts are not evidence of production failures.

## 0.2.0

- Long or redacted tool results no longer kill the turn: complete `[REDACTED]` lines and Muse's 64 KiB view truncation (including one-line results) are reconciled against Pi's original result. Unsupported vendor transformations still stop safely.
- Support qualified Muse Code 1.4.15-R8339.1 alongside 1.4.14-R7309.1, including session MCP readiness and canonical private-workspace trust paths.
- Expose the full valid provider catalogue (Ember and Spark 1.2 appear); offer contributor picker routes only for verified model recipes (Spark 1.3/1.2, Wonder, Wonder Full), without guessing support for unknown models.
- Newer Muse Code clients warn instead of disappearing from `/model`; `PI_MUSE_TETHER_STRICT_VERSION=1` refuses them. Coding still requires a qualified client build.
- After switching an existing install to 1.4.15, run one Muse turn so the client rewrites its saved model list in the new format; until then the client serves only its built-in list.

## 0.1.1

- Pi's provider hooks now fire.
- Tool results with images no longer kill the turn, including JPEG and several images at once.
- `[REDACTED]` at the start or end of a line, or across a whole line, no longer kills the turn. Any other changed text still stops it.
- Invalid tool arguments now get Pi's normal validation error, so the model can fix the call instead of stopping at an opaque denial.
- A quota refusal no longer blocks the whole account for the session.
- One bad model entry no longer blocks the others, and `/muse-doctor` reports catalog failures.
- An empty `XDG_STATE_HOME` now falls back to the home state folder.
