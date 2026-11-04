import { writeFileSync } from "node:fs";
/** Synthetic branch longer than Pi's documented 20,000-token keep-recent default. */
export default function (pi: any) {
  pi.on("session_start", (_: any, ctx: any) => {
    const timestamp = Date.now();
    const user = (text: string) => ({
      role: "user",
      content: [{ type: "text", text }],
      timestamp,
    });
    const assistant = () => ({
      role: "assistant",
      content: [{ type: "text", text: "synthetic answer" }],
      api: "pi-muse-tether",
      provider: "pi-muse-tether",
      model: "echo",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    });
    ctx.sessionManager.appendMessage(user("synthetic early branch"));
    ctx.sessionManager.appendMessage(assistant());
    ctx.sessionManager.appendMessage(user("synthetic ".repeat(12000)));
    ctx.sessionManager.appendMessage(assistant());
  });
  pi.on("session_before_compact", (event: any) => {
    writeFileSync(process.env.COMPACT_HOOK_MARKER!, event.reason);
  });
}
