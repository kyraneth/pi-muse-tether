export function assertOfflineModel(model: any) {
  if (
    model?.provider !== "pi-muse-tether" ||
    model?.api !== "pi-muse-tether" ||
    model?.baseUrl !== "pi-muse-tether"
  )
    throw new Error(
      "OFFLINE ROUTE GUARD: resolved model inherited a foreign provider/API/baseUrl; no prompt dispatched",
    );
}
/** Explicit catalog projection: never spread a builtin transport into a fixture. */
export function fixtureModel(base: any) {
  return {
    id: "echo",
    name: "Verification offline official SDK fixture",
    reasoning: true,
    input: ["text", "image"],
    cost: base.cost,
    contextWindow: base.contextWindow,
    maxTokens: base.maxTokens,
    thinkingLevelMap: {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  };
}
