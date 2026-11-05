import { museThinkingLevelMap } from "./thinking-config.js";
import { museModelCost } from "./usage.js";
export { isQualifiedMuseModel, museResponseIdentity } from "./model-route.js";

/** Supported official logical IDs, never invented contributor aliases. Limits
 * and efforts come exclusively from the receiving official model/list. */
export const MUSE_MODEL_GROUPS = [
  ["muse-spark-1.3", "muse-spark-1.3-contributor"],
  ["muse-wonder-1.0"],
  ["muse-wonder-full-1.0"],
] as const;
const isCatalogueModel = (id: string) =>
  MUSE_MODEL_GROUPS.some(group => (group as readonly string[]).includes(id));

/** Diagnosis only, no workaround: an official client may receive no models
 * on one network path while the same account works on another. */
export const EMPTY_CATALOGUE_HINT = ". The official Muse client received an empty model catalogue. "
  + "If `muse exec` on this machine also reports \"does not exist or you lack access\" while the same "
  + "account works elsewhere, Meta may be refusing this network path (seen on datacenter IPv6); "
  + "see the pi-muse-tether README section \"Empty catalogue on some cloud networks\"";

export function museCatalogAssessment(catalog: any) {
  const rows: any[] = Array.isArray(catalog?.models) ? catalog.models : [];
  const valid = (catalog?.source === "providerCatalog" ? rows : []).filter(m => m && typeof m === "object" && isCatalogueModel(m.modelId) &&
    m.providerId === "meta" && typeof m.displayLabel === "string" && m.displayLabel.length &&
    Number.isSafeInteger(m.contextLimit) && m.contextLimit > 0 &&
    Number.isSafeInteger(m.outputLimit) && m.outputLimit > 0 &&
    Array.isArray(m.variants) && m.variants.length &&
    m.variants.every((tier: unknown) => typeof tier === "string" &&
      Object.values(museThinkingLevelMap([tier])).includes(tier)) &&
    m.variants.includes(m.defaultReasoningEffort));
  const missing = MUSE_MODEL_GROUPS.filter(group => !valid.some(m => (group as readonly string[]).includes(m.modelId)));
  return { valid, diagnostics: { source: catalog?.source ?? null, providerId: catalog?.providerId ?? null,
    profileId: catalog?.profileId ?? null, missing, models: rows.map(m => ({modelId:m?.modelId,contextLimit:m?.contextLimit,outputLimit:m?.outputLimit,variants:m?.variants})),
    ...(!rows.length ? {hint:EMPTY_CATALOGUE_HINT} : {}) } };
}

export function museCatalogModels(catalog: any) {
  const {valid} = museCatalogAssessment(catalog);
  return valid.flatMap(m => (m.modelId.includes("wonder") ? ["off", "on"] : ["on"]).map(contributorMode => ({
    id: m.modelId.includes("wonder") && contributorMode === "on" ? `${m.modelId}-contributor` : m.modelId,
    name: `${m.displayLabel} · ${contributorMode === "on" ? "Contributor" : "Normal"}${museModelCost(m.modelId).input === null ? " · pricing unknown" : ""}`,
    reasoning: m.variants.some((tier: string) => tier !== "none"),
    input: ["text", "image"] as ("text" | "image")[],
    thinkingLevelMap: museThinkingLevelMap(m.variants),
    contextWindow: m.contextLimit, maxTokens: m.outputLimit,
    // Pi's numeric-only cost interface has no unknown variant. Nulls are
    // intentional runtime metadata, not zero prices; never borrow Spark rates.
    cost: museModelCost(m.modelId) as any,
  })));
}
