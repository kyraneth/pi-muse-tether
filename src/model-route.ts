/** Shape only, never an availability allowlist. The host checks model/list
 * again before submitting a turn. Contributor suffixes are local CLI recipes. */
export const isMuseModelId = (id: unknown): id is string =>
  typeof id === "string" && /^muse-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id);

/** Verified 2026-11-10 by official-client contributor on/off request traces
 * (the wire model ID changes only for these) and direct Meta API requests.
 * Ember ignores contributor mode and its contributor API ID returns model_not_found.
 * This gates contributor recipes only, never normal catalogue availability.
 * Add a native ID only after verifying its contributor wire model and API support. */
export const VERIFIED_CONTRIBUTOR_MODEL_IDS: ReadonlySet<string> = new Set([
  "muse-spark-1.3", "muse-spark-1.2", "muse-wonder-1.0", "muse-wonder-full-1.0",
]);

export function museModelRoute(id: string): {modelId:string;contributorMode:"on"|"off"} | undefined {
  if (!isMuseModelId(id)) return undefined;
  const contributor = id.endsWith("-contributor");
  const modelId = contributor ? id.slice(0, -"-contributor".length) : id;
  if (!isMuseModelId(modelId) || (contributor && !VERIFIED_CONTRIBUTOR_MODEL_IDS.has(modelId))) return undefined;
  return {modelId, contributorMode: contributor || modelId === "muse-spark-1.3" ? "on" : "off"};
}
export const isQualifiedMuseModel = (id:string) => museModelRoute(id) !== undefined;
export function museResponseIdentity(id:string) {
  const route = museModelRoute(id);
  if (!route) return {};
  if (route.modelId === "muse-spark-1.3")
    return {responseModel:"muse-spark-1.3-contributor",responseModelSource:"derived:fixed-contributor-on-recipe",contributorMode:route.contributorMode,nativeModel:route.modelId};
  // Recipe-derived identity, not a claim that the response carried model metadata.
  return {responseModel:route.contributorMode === "on" ? `${route.modelId}-contributor` : route.modelId,
    responseModelSource:"derived:selected-native-model-and-contributor-recipe",contributorMode:route.contributorMode,nativeModel:route.modelId};
}
