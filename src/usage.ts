import { calculateCost } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { museResponseIdentity } from "./model-route.js";

/** API reference metadata, not entitlement or an observed physical model. */
export function museApiReference(pickerId: string) {
  const { responseModel } = museResponseIdentity(pickerId);
  return responseModel ? getBuiltinModels("meta").find(model => model.id === responseModel) : undefined;
}
const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const UNKNOWN_RATES = { input: null, output: null, cacheRead: null, cacheWrite: null } as const;
export const NO_PRICE_TABLE = "unknown:no-applicable-price-table;not-subscription-billing";
export const NO_USAGE = "unknown:no-usable-native-usage;not-subscription-billing";
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const counter = (n: unknown) => finite(n) ? n : null;

/** Price one distinct MSP usage record before summing any episode. The caller
 * owns deduplication by native request identity. MSP does not attest attempts
 * that lacked a usage record. */
export function museRequestUsage(pickerId: string | null, p: any) {
  const u = p?.usage;
  const native = {
    inputTokens: counter(u?.inputTokens), outputTokens: counter(u?.outputTokens),
    cacheReadTokens: counter(u?.cacheReadTokens), cacheWriteTokens: counter(u?.cacheWriteTokens),
    cachedTokens: counter(u?.cachedTokens), reasoningTokens: counter(u?.reasoningTokens),
  };
  const cacheRead = native.cacheReadTokens ?? native.cachedTokens;
  const cacheWrite = native.cacheWriteTokens;
  const input = native.inputTokens === null ? null : native.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0);
  const invalid = input !== null && input < 0;
  const tokens = { input, output: native.outputTokens, cacheRead, cacheWrite };
  const table = pickerId ? museApiReference(pickerId) : undefined;
  const estimate = table?.cost && !invalid && keys.some(key => tokens[key] !== null)
    ? calculateCost(table, {
        input: input ?? 0, output: tokens.output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0,
        totalTokens: counter(p.totalTokens) ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      })
    : undefined;
  return {
    native, tokens, invalid,
    referenceCost: estimate ? {
      input: estimate.input, output: estimate.output, cacheRead: estimate.cacheRead, cacheWrite: estimate.cacheWrite, total: estimate.total,
    } : null,
    referenceCostSource: !table?.cost ? NO_PRICE_TABLE : estimate ? `derived:Pi-meta:${table.id};not-subscription-billing` : NO_USAGE,
    referenceCostPartial: !estimate || keys.some(key => tokens[key] === null),
  };
}

/** Native Meta input includes the cached components. Pi's input is uncached. */
export function applyMuseUsage(output: any, p: any) {
  const { native, tokens, invalid, referenceCost, referenceCostSource, referenceCostPartial } = museRequestUsage(output.model, p);
  if (invalid) throw new Error("Muse cache read/write exceeds native input");
  const priorUsage = output.nativeUsage.length > 0;
  output.nativeUsage.push(native);
  for (const key of keys) {
    const count = tokens[key];
    if (count !== null) {
      output.usage[key] += count;
      output.usagePresence[key] = true;
    }
  }
  if (tokens.input !== null) output.usageInputSource = tokens.cacheRead === null || tokens.cacheWrite === null
    ? "native:inputTokens;partial-cache-split"
    : "derived:native-input-minus-cache-read-and-write";
  if (native.cacheReadTokens === null && native.cachedTokens !== null)
    output.cacheReadSource = "derived:Meta-cachedTokens";
  if (native.reasoningTokens !== null)
    output.usage.reasoning = (output.usage.reasoning ?? 0) + native.reasoningTokens;
  // Pi uses totalTokens as current context size, not cumulative spend.
  if (finite(p.totalTokens)) {
    output.usage.totalTokens = p.totalTokens;
    output.usageTotalSource = "native:last-session/tokenUsage.totalTokens (server-derived promptTokens+outputTokens)";
  }
  const cost = output.usage.cost;
  if (referenceCost) {
    for (const key of [...keys, "total"] as const)
      cost[key] = (cost[key] ?? 0) + referenceCost[key];
    output.costSource = referenceCostSource;
  } else if (!priorUsage || cost.total == null) {
    Object.assign(cost, UNKNOWN_RATES, { total: null });
    output.costSource = referenceCostSource;
  }
  output.costPartial = referenceCostPartial || (priorUsage && output.costPartial === true);
  output.nativeCumulativeCost = finite(p.cumulative?.cost?.usd)
    ? { usd: p.cumulative.cost.usd, partial: p.cumulative.cost.partial === true, source: "native:server-estimate;cumulative;not-added" }
    : null;
}
