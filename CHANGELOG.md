# Changelog

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
