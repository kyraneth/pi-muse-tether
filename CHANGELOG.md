# Changelog

## 0.1.1

- Pi's provider hooks now fire.
- Tool results with images no longer kill the turn, including JPEG and several images at once.
- `[REDACTED]` at the start or end of a line, or across a whole line, no longer kills the turn. Any other changed text still stops it.
- Invalid tool arguments now get Pi's normal validation error, so the model can fix the call instead of stopping at an opaque denial.
- A quota refusal no longer blocks the whole account for the session.
- One bad model entry no longer blocks the others, and `/muse-doctor` reports catalog failures.
- An empty `XDG_STATE_HOME` now falls back to the home state folder.
