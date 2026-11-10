import { museThinkingLevelMap } from "./thinking-config.js";
import { museModelCost } from "./usage.js";
import { isMuseModelId, museModelRoute } from "./model-route.js";
export { isQualifiedMuseModel, museResponseIdentity } from "./model-route.js";

/** Diagnosis only, no workaround: an official client may receive no models
 * on one network path while the same account works on another. */
export const EMPTY_CATALOGUE_HINT = ". The official Muse client received an empty model catalogue. "
  + "If `muse exec` on this machine also reports \"does not exist or you lack access\" while the same "
  + "account works elsewhere, Meta may be refusing this network path (seen on datacenter IPv6); "
  + "see the pi-muse-tether README section \"Empty catalogue on some cloud networks\"";

/** Contributor suffixes belong to the picker, never the native namespace. */
function catalogueIdProblem(id: unknown): string | undefined {
  if (!isMuseModelId(id)) return "invalid Muse model ID shape";
  if (id.endsWith("-contributor")) return "reserved local -contributor suffix";
}

export function museCatalogAssessment(catalog: any) {
  const rows: any[] = Array.isArray(catalog?.models) ? catalog.models : [];
  const valid = (catalog?.source === "providerCatalog" ? rows : []).filter(m => m && typeof m === "object" && !catalogueIdProblem(m.modelId) &&
    m.providerId === "meta" && typeof m.displayLabel === "string" && m.displayLabel.length &&
    Number.isSafeInteger(m.contextLimit) && m.contextLimit > 0 &&
    Number.isSafeInteger(m.outputLimit) && m.outputLimit > 0 &&
    Array.isArray(m.variants) && m.variants.length &&
    m.variants.every((tier: unknown) => typeof tier === "string" &&
      Object.values(museThinkingLevelMap([tier])).includes(tier)) &&
    m.variants.includes(m.defaultReasoningEffort));
  return { valid, diagnostics: { source: catalog?.source ?? null, providerId: catalog?.providerId ?? null,
    profileId: catalog?.profileId ?? null,
    rejectedRoutes: rows.flatMap(m => {
      const reason = catalogueIdProblem(m?.modelId);
      return reason ? [`${String(m?.modelId)}: ${reason}`] : [];
    }), models: rows.map(m => ({modelId:m?.modelId,contextLimit:m?.contextLimit,outputLimit:m?.outputLimit,variants:m?.variants})),
    ...(!rows.length ? {hint:EMPTY_CATALOGUE_HINT} : {}) } };
}

export function museCatalogModels(catalog: any) {
  const {valid} = museCatalogAssessment(catalog);
  return valid.flatMap(m => [m.modelId, `${m.modelId}-contributor`].filter(id => museModelRoute(id)).map(id => {
    const {contributorMode} = museModelRoute(id)!;
    return {
      id,
      name: `${m.displayLabel} · ${contributorMode === "on" ? "Contributor" : "Normal"}${museModelCost(m.modelId).input === null ? " · pricing unknown" : ""}`,
      reasoning: m.variants.some((tier: string) => tier !== "none"),
      input: ["text", "image"] as ("text" | "image")[],
      thinkingLevelMap: museThinkingLevelMap(m.variants),
      contextWindow: m.contextLimit, maxTokens: m.outputLimit,
      // Pi's numeric-only cost interface has no unknown variant. Nulls are
      // intentional runtime metadata, not zero prices; never borrow Spark rates.
      cost: museModelCost(m.modelId) as any,
    };
  }));
}
