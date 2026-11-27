# Official client lifecycle and qualification

## Decision implemented

The revised delivery follows the user's official Muse launcher, like the Claude
Code tether. Meta owns updates; the tether owns capability negotiation and
runtime validation. `PI_MUSE_TETHER_BINARY` remains an explicit absolute-path
override. Production does not force `MUSE_NO_AUTO_UPDATE`; development, tests,
qualification and proofs set it to `1`. `PI_MUSE_TETHER_STRICT_VERSION=1` remains
an explicit refusal above the tested range. Otherwise newer builds run and the ledger and doctor report that the version is unqualified.

The originally proposed pinned-client store was rejected and is not shipped.
The emergency binary override is not an alternate automatic installation route.

## What the launcher actually does

Read on 2026-11-16: launcher version 3 from the existing installation. It resolves
its own directory, supports `muse-stable`/`muse-canary` channel heads only, and
has **no historical-build selector**. `MUSE_LAUNCHER_INSTALL=1` installs beside
the copied launcher, checking the channel manifest, release version, artifact
size and SHA-256. After a successful installation it deletes **all sibling
`muse-bin-*` builds except the selected one**. A pinned store therefore
would have needed separate staging to avoid pruning retained builds. No such
store or installer is managed by the tether.

A plain launcher invocation may update even for `--version`. Tests and proofs
must therefore never invoke it without `MUSE_NO_AUTO_UPDATE=1`. Version cache
entries bind launcher/selector/executable metadata and are invalidated by any
observed identity change; unknown override launchers are probed each time.

## Identity and login (unchanged)

The existing official launcher resolves login to `MUSE_AUTH_PATH`, else
`$XDG_CONFIG_HOME/muse/auth.json`, else `$HOME/.config/muse/auth.json`.
On this node, metadata-only inspection found the existing login at
`~/.config/muse/auth.json` (regular file, mode 0600); no token contents were
read, copied or printed. The official binary installed by the copied launcher
has SHA-256 `3685b023d45a1a07c8c559da00088bdf59564920b13a85adad11e13ad6f4d181`
for build `1.4.20-R8619.1`. Installation did not sign in again.

`settings.ts:linkHostLogin` is unchanged: each private-prompt host writes its
own isolated settings/trust files and symlinks only `config/muse/auth.json` to
the existing login. It stats the real file before/after, verifies that the
symlink still points to the same destination, and stops if the client replaces
that symlink. Legitimate rotation of the real destination is recorded as
metadata, not copied or repaired. Explicit `MUSE_AUTH_PATH` is inherited by the
official client. There is no impersonation, second credential store, or API-key
fallback; `META_API_KEY` is excluded from the model host environment.

Catalogue discovery and each Muse host give only their vendor subprocesses
writable `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` under `TMPDIR`.
Discovery keeps the client's normal home and config selection and copies its saved
model catalogue, if present, into the disposable data root. The client still
chooses the provider and profile; a bundled response is not registered as a live
catalogue. Discovery failures are printed at startup (including `--list-models`)
and remain visible in `/muse-doctor`. A private host shares its disposable roots
between `skills list` and `serve`. Bundled skills
may be materialized again when a new host opens. Pi, the tether ledger and
qualification evidence still use their own configured paths, which must be
writable when used. Account access is still required for live use.

## Batching is a capability, not a build string

A new build is not denied for lacking qualification evidence: it runs sequential
tools. Batch eligibility comes from records matching executable/schema identity,
plus the two historical seed records, rather than a hand-edited admission
constant. Explicit live qualification can certify a new build without editing
code. The host additionally requests `rawLog`, requires the ordinary session-MCP
protocol, and validates
committed batch frames against retained v1.4.14/v1.4.15 envelope definitions in
`assets/batch-boundary-schemas.json`. Their original whole-schema SHA-256s are
retained in that file. **Those upstream schemas explicitly declare the payload
unstable and free-form**. The tether additionally checks every consumed event
and tool-call field; it does not claim the upstream envelope schema attests the
payload vocabulary.

Absent grant/stream/boundary, log gaps or a shape mismatch disable batching for
that host with one visible notice. Approved MCP calls are then surfaced and
verified one at a time; concurrent native calls queue rather than being rejected
or replayed. Foreign turn identities, conflicting duplicate calls, failed
authentication and incompatible base protocols still refuse. A server-required
upgrade is surfaced as `MUSE_UPGRADE_REQUIRED`, never silently retried on a
different client.

## Stopping a turn

Pi owns cancellation. The tether retires the host, requests `turn/cancel` at
most once if it knows the active native turn ID, and closes and reaps through
the SDK without waiting for a cancel acknowledgement. A matching orderly
`session/closed` during that close is not a failure. An unsolicited close
while work is pending still fences the request. A lost admission reply means
Muse may already have accepted work; the tether does not silently replay the
same Pi user entry. Cancellation does not undo tools that Pi already ran.

For an opt-in live check, start isolated Pi RPC with the Muse extension, a
copied official binary, a separate ledger and the account owner's existing
login link. Select `pi-muse-tether/muse-ember-1.0` at `minimal` and send one
short `prompt`. On the first observed native start (or `turn_admitted` ledger
row), send `{"id":"abort","type":"abort"}` on the same RPC stdin. Pi's initial
`agent_start` is not evidence of Muse admission. Check the RPC abort response
and aborted assistant output, one matching `turn_cancel_requested` ledger row,
and the child exit. `turn_terminal_during_close`, if present, is native status;
a cancel request or process exit alone does not prove the vendor stopped work
or billing. If the answer wins the race, report that the intended abort
boundary was not observed; do not automatically retry.

## Offline conformance and isolation evidence

The official echo probe waits for `mcpServer/readInventory` to report its fixture
server connected with the exact supplied tools before starting the turn. On
current clients, starting a turn earlier can expose an empty toolset or fail
before a `model_request_configured` event exists. The test still requires that
real event, exact named tools, absence of false read-only policy, the negative
policy control, and rejection of a missing tool. It uses no version-specific
waiver and does not treat a missing event as success.

`npm test` runs both Vitest and node:test even when either phase fails; the
combined result fails if either does. Both phases print individual test names.
The guard snapshots the launcher, installed binaries, selector, qualification
homes and request ledger before and after, including newly added/removed files.
Version-only diagnostic probes also use fresh HOME/XDG roots, never the user's
ordinary configuration home. There is no client-store environment or pin state.

## Shared tether-core contract (proposed for adoption)

A vendor tether must separate: (1) official executable identity/update ownership,
(2) protocol capability negotiation, (3) schema-checked optional accelerations,
and (4) qualification evidence. An unqualified-version diagnostic is not evidence that optional
capabilities work, and an unknown optional capability must not deny a basic turn.
No vendor tether may silently switch identities, create another login, replay an
unknown request, or write test/proof telemetry to the user's live ledger.
Qualification records bind exact executable SHA-256 and schema hash, with named
check results; they enable optional accelerations, not whole-turn admission.
The private replacement requires experimental negotiation; if withheld, the
isolated host is reopened before any model request with supported
`run.developer_prompt` instructions appended to Muse's own prompt. A typed
ledger and doctor name that reduced guarantee. Missing session MCP refuses with build and
cause; there is no fallback to vendor-owned tools.

This document specifies the shared contract; it does not claim the separate
`pi-tether-core` or Claude/agy repositories were changed in this PR.
