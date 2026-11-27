import { lowestMuseThinkingLevel, museThinkingLevelMap } from "./thinking-config.js";
import { museApiReference, UNKNOWN_RATES } from "./usage.js";
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
    m.variants.every((tier: unknown) => typeof tier === "string" && /^[a-z][a-z0-9_-]*$/.test(tier)) &&
    m.variants.includes(m.defaultReasoningEffort) && lowestMuseThinkingLevel(m.variants) !== undefined);
  return { valid, diagnostics: { source: catalog?.source ?? null, providerId: catalog?.providerId ?? null,
    profileId: catalog?.profileId ?? null,
    rejectedRoutes: rows.flatMap(m => {
      const reason = catalogueIdProblem(m?.modelId);
      return reason ? [`${String(m?.modelId)}: ${reason}`] : [];
    }), models: rows.map(m => ({modelId:m?.modelId,contextLimit:m?.contextLimit,outputLimit:m?.outputLimit,variants:m?.variants,
      ...(Array.isArray(m?.variants) ? {unmappedEfforts:m.variants.filter((tier:unknown) => !lowestMuseThinkingLevel([tier]))} : {})})),
    ...(!rows.length ? {hint:EMPTY_CATALOGUE_HINT} : {}) } };
}

export function museCatalogModels(catalog: any) {
  const {valid} = museCatalogAssessment(catalog);
  return valid.flatMap(m => [m.modelId, `${m.modelId}-contributor`].filter(id => museModelRoute(id)).map(id => {
    const {contributorMode} = museModelRoute(id)!;
    const table = museApiReference(id);
    const recipeName = id === "muse-spark-1.3" ? "Contributor (legacy alias)"
      : contributorMode === "on" ? "Contributor" : "Normal";
    return {
      id,
      name: `${m.displayLabel} · ${recipeName}${table?.cost ? "" : " · pricing unknown"}`,
      reasoning: Object.entries(museThinkingLevelMap(m.variants)).some(([level, tier]) => level !== "off" && tier !== null),
      input: ["text", "image"] as ("text" | "image")[],
      thinkingLevelMap: museThinkingLevelMap(m.variants),
      contextWindow: m.contextLimit, maxTokens: m.outputLimit,
      // Pi's numeric-only interface has no unknown variant. Never borrow
      // another recipe's rate or image metadata.
      cost: table?.cost ?? { ...UNKNOWN_RATES } as any,
      ...(table?.inputLimits ? { inputLimits: table.inputLimits } : {}),
    };
  }));
}
