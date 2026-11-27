import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { registerMuseExtension } from "../index.js";
import { assertMusePolicySafe } from "../src/host.js";
import { createMuseProvider } from "../src/provider.js";
import { fixtureState, openFixtureHost } from "./fixture-host.js";

/** Native Pi extension hooks backed by the real SDK's offline MSP ingress. */
export default async function (pi: any) {
  const scenario = process.env.LOGICAL_HOOK_SCENARIO;
  const log = (kind: string, data = {}) => process.send!({ kind, ...data });
  const declarations = (tools: any[]) => tools.map(({ name, description }) => ({ name, description }));
  for (const name of ["first", "second", "third"]) {
    pi.registerTool({ name, label: name, description: `Original ${name}`, parameters: Type.Object({}),
      async execute() { log("executed", { name }); throw new Error("Unsolicited tool execution"); },
    });
  }
  pi.on("before_provider_request", async ({ payload }: any) => {
    log("payload", { transport: payload.transport, systemPrompt: payload.systemPrompt, tools: declarations(payload.tools) });
    if (scenario === "validation") return { ...payload, systemPrompt: null };
    if (scenario === "remove-first") payload.tools.shift();
    if (scenario === "reorder") return { ...payload, tools: payload.tools.toReversed().map((tool: any) => ({ ...tool, description: `Edited ${tool.name}` })) };
    if (scenario === "empty") return { ...payload, tools: [] };
  });
  let releaseAfterObservation: (() => void) | undefined;
  pi.on("after_provider_response", async ({ status, headers }: any) => {
    const release = new Promise<void>(resolve => process.once("message", () => resolve()));
    log("response", { status, headers });
    if (scenario === "policy") {
      try { assertMusePolicySafe(); }
      catch (error: any) { log("policy-latched", { reason: error.message }); }
    }
    await release;
    log("observer-released");
    if (scenario === "policy") throw new Error("Synthetic observer error");
    releaseAfterObservation?.();
  });
  pi.on("provider_stream_event", ({ data }: any) => log("stream", { method: data.event.frame?.method }));
  pi.on("message_end", ({ message }: any) => { if (message.role === "assistant") log("terminal", { stopReason: message.stopReason }); });

  fixtureState.beforeTurnStart = ({ close, reply, notify, frame, refuse }: any) => {
    const turnId = frame.params.commandId;
    if (scenario === "transport-loss") { close(); return true; }
    if (scenario === "post-ack") {
      reply(frame, { commandId: turnId, status: "accepted", disposition: "started", turnId });
      notify("turn/started", { commandId: turnId, turnId });
      releaseAfterObservation = () => notify("turn/completed", { turnId, terminal: "failed", error: { kind: "generationFailed", message: "Synthetic post-ack failure" } });
      return true;
    }
    if (scenario === "429" || scenario === "unnumbered" || scenario === "policy") {
      // A scoped ingress frame can reach the host before the response. It must
      // never be forwarded when the command receives a typed rejection.
      notify("item/started", { turnId, item: { itemId: "not-admitted", kind: "agentMessage" } });
      log("pre-admission-frame-sent");
      refuse({ code: -32001, message: "Synthetic refusal HTTP 429",
        data: scenario === "429" ? { kind: "quota_exceeded", httpStatus: 429 } :
          scenario === "policy" ? { kind: "client_attestation_denied", httpStatus: 403 } : { kind: "invalidInput" } });
      return true;
    }
    return false;
  };

  const provider = createMuseProvider({
    promptModes: ["replace"], promptMode: "replace", instructionMechanisms: ["fixture"], rawCompletion: true,
    async openHost(options) {
      const schemaPath = (options.mcpServers?.pi as { args?: string[] })?.args?.at(-1);
      log("registered", { purpose: options.purpose ?? "coding", systemPrompt: options.privatePrompt?.systemPrompt,
        tools: schemaPath ? declarations(JSON.parse(readFileSync(schemaPath, "utf8")).tools) : [] });
      const host = await openFixtureHost({ ...options, onEvent(event) {
        if (event.kind === "fenced") log("fenced", { reason: event.reason });
        if (event.kind === "frame") log("ingress", { method: event.frame.method });
        options.onEvent?.(event);
      } });
      return host;
    },
  });
  await registerMuseExtension(pi, provider);
}
