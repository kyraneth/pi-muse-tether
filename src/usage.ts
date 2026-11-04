/** Rates from Pi1.5.0 official meta contributor catalog, USD per million tokens.
 * Not subscription charges. Never use Spark's non-contributor price table.
 */
export const CONTRIBUTOR_COST = {
  input: 0.1,
  output: 0.2,
  cacheRead: 0.002,
  cacheWrite: 0,
};
/** No applicable Wonder normal/contributor tariff exists in retained official metadata. */
export function museModelCost(id: string) {
  return ["muse-spark-1.3", "muse-spark-1.3-contributor"].includes(id)
    ? CONTRIBUTOR_COST
    : { input: null, output: null, cacheRead: null, cacheWrite: null };
}
const finite = (n: any) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
export function nativeCounters(u: any) {
  return Object.fromEntries(
    [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "cachedTokens",
      "reasoningTokens",
    ].map((k) => [k, finite(u?.[k]) ? u[k] : null]),
  );
}
/** Native Meta input includes cache reads. Pi's input is the uncached component. */
export function applyMuseUsage(output: any, p: any) {
  const u = nativeCounters(p.usage),
    known = (k: string) => u[k] !== null;
  output.nativeUsage.push(u);
  if (known("inputTokens")) {
    const cached = u.cacheReadTokens ?? u.cachedTokens;
    const writes = u.cacheWriteTokens ?? 0;
    if (cached !== null && cached + writes > u.inputTokens)
      throw new Error("Muse cache read exceeds native input");
    output.usage.input += u.inputTokens - (cached ?? 0) - writes;
    output.usagePresence.input = true;
    output.usageInputSource =
      cached !== null
        ? "derived:native-input-minus-cache-read-and-write"
        : "native:inputTokens;cache-split-unknown";
  }
  for (const [native, key] of [
    ["outputTokens", "output"],
    ["cacheReadTokens", "cacheRead"],
    ["cacheWriteTokens", "cacheWrite"],
  ])
    if (known(native)) {
      output.usage[key] += u[native];
      output.usagePresence[key] = true;
    }
  if (!known("cacheReadTokens") && known("cachedTokens")) {
    output.usage.cacheRead += u.cachedTokens;
    output.usagePresence.cacheRead = true;
    output.cacheReadSource = "derived:Meta-cachedTokens";
  }
  if (known("reasoningTokens"))
    output.usage.reasoning = (output.usage.reasoning ?? 0) + u.reasoningTokens;
  // Pi uses totalTokens as current context size, not cumulative spend.
  if (finite(p.totalTokens)) output.usage.totalTokens = p.totalTokens;
  output.usageTotalSource =
    "native:last-session/tokenUsage.totalTokens (server-derived promptTokens+outputTokens)";
  const cost = output.usage.cost;
  const rates = museModelCost(output.model);
  const priced = rates.input !== null;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
    cost[key] = rates[key] === null ? null : (output.usage[key] * rates[key]) / 1e6;
  cost.total = priced ? cost.input + cost.output + cost.cacheRead + cost.cacheWrite : null;
  output.costSource = priced
    ? "derived:Pi1.5.0-meta-muse-spark-1.3-contributor-price-table;not-subscription-billing"
    : "unknown:no-applicable-price-table;not-subscription-billing";
  output.costPartial =
    !priced ||
    !output.usagePresence.input ||
    !output.usagePresence.output ||
    !output.usagePresence.cacheRead;
  output.nativeCumulativeCost = finite(p.cumulative?.cost?.usd)
    ? {
        usd: p.cumulative.cost.usd,
        partial: p.cumulative.cost.partial === true,
        source: "native:server-estimate;cumulative;not-added",
      }
    : null;
}
