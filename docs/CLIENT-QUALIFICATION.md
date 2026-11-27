# Client qualification

The official Muse launcher owns updates. The tether does **not** install, pin,
retain or promote vendor clients. Qualification is evidence about particular
executable bytes, not a build-string permission to run ordinary turns.
`PI_MUSE_TETHER_BINARY` remains an emergency explicit official-binary override.

## Command and integration

```text
/muse-doctor qualify [build]          # offline only; no model request
/muse-doctor qualify [build] --live   # explicit gate AND interactive confirmation
```

The doctor calls `await qualifyClient(build?, live = false)` from
`src/qualification.ts`. Before passing `true`, it must obtain UI confirmation.
The function additionally requires `PI_MUSE_TETHER_LIVE=1`; setting that variable
alone does not run the live suite. A requested build must equal the selected
client's reported build. The official launcher cannot install historical builds;
qualification never tries to do so.

Qualification uses the owning `src/qualification-records.ts` helpers, not a
client store. It writes `{build, sha256, schemaHash, results, qualified}` under
`qualificationHome()` (override: `PI_MUSE_TETHER_QUALIFICATION_HOME`).
`results.offline` is a boolean. `results.live` contains individual status/detail
objects for `batchBoundary`, `privatePrompt`, `sessionMcp`, `resume`, and `image`.
`qualified` is true **only when offline conformance and all five live checks
pass**. Offline success alone never enables full qualification. An offline recheck preserves existing live evidence only when both executable
SHA-256 and schema hash match exactly; it does not rerun or renew that live
proof. A changed identity gets fresh incomplete results. Successful/failed live
runs retain their isolated result location in `results.liveEvidence`. A complete
matching record enables optional batching on subsequent hosts, still subject to
negotiation and runtime validation. No installation or client update is implicit.

## Offline conformance

1. Resolve the selected official executable and hash its bytes, not the launcher.
2. Inspect `schema --help` and `schema generate-json-schema --help`.
3. Run the advertised `schema generate-json-schema --experimental --out <temp>`
   and hash the actual `msp.schema.json` bytes.
4. Compare the reachable `LogRecordParams` and `RawLogRecordEnvelope` contracts
   against the retained v1414/v1415 schema fixtures in
   `assets/batch-boundary-schemas.json`. Their original source hashes are retained
   in that asset. Descriptions/titles/comments do not affect compatibility;
   changed wire shapes or unresolved references fail conservatively for review.
5. Recheck the executable hash before writing the record. An identity race refuses
   the write rather than attaching evidence to different bytes.

Every qualification CLI invocation has `MUSE_NO_AUTO_UPDATE=1`. Schema operations
use a fresh HOME/XDG workspace and are cleaned up. No token is read or copied.
The free-form committed event payload is **not** proven by schema equality:
`committedCalls` runtime validation and an actual live batch event remain needed.
Offline checks do not certify exhaustive private-prompt isolation or session MCP.

## Explicit live suite (never part of ordinary tests)

Select a Muse model in Pi, then authorize the doctor command above. Outside a
Muse picker context, set `PI_MUSE_TETHER_QUALIFICATION_MODEL` to an explicit
Muse picker ID, including any Contributor suffix. The runner does not guess a
model. It resolves that exact recipe against the official provider catalogue,
uses the registered limits, and runs at its lowest supported Pi thinking level.
Each scenario runs once; failure stops subsequent scenarios, without replay.

A subprocess owns a unique HOME, all four XDG roots, ledger and Pi session
journal. It resolves Jiti through the installed Pi package to load the TypeScript
module. It links the existing login by metadata-only `linkHostLogin`, never copies
or reads credentials, and verifies the symlink metadata after cleanup. The
original login is the only deliberately shared account state; normal official
login refresh may still change its metadata. The worker home and synthetic
journal are retained under `qualificationHome()/live-*` for review, including
failed/unknown outcomes. Do not blindly re-run an interrupted worker.

The worker uses the real provider, Agent, MCP broker and official host:

| Check | Required observation |
| --- | --- |
| Private prompt | Exact randomized synthetic label supplied only in the private system prompt is returned. This tests prompt delivery, not exhaustive suppression of every foreign rule. |
| Session MCP | Pi executes both synthetic `qualification_read` invocations once, journals separate results, and the final answer contains both randomized outputs. |
| Batch boundary | One actual `tool-batch` host event contains both fixture keys. Timing overlap or two separate calls does not count. |
| Resume | Retire the real ephemeral host, restore messages from the Pi journal, and recall the earlier randomized tool output without tools. This is Pi history replay, **not native Muse session resume**. |
| Image | Submit real PNG bytes for a randomized red/blue swatch through Pi image input and check the answer. This is not proof of tool-result image receipt parity. |

The worker passes `qualificationProbe:true` to the host under its isolated-worker
marker so a new candidate can exercise batches before it has a successful record.
This bypasses only the prior-record gate: rawLog negotiation and runtime frame
validation still apply. Ordinary runtime must not use this probe option.

No missing check is treated as a pass. Exceptions, failed assertions, incomplete
workers and login verification failures leave `qualified:false`. This module
never auto-promotes or auto-updates anything, and its live runner is not a
substitute for the root-owned single authorized end-to-end production proof.

## Verification performed during implementation

`tests/qualification.test.ts` exercises fake read-only executable commands,
retained schema compatibility, hash-bound records, explicit live gates, build
mismatch refusal and failure records. Those tests do not call a model or award
live qualification. See the exact build's qualification record for live evidence.
