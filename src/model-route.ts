/** Local picker routes, NOT a list of physical provider model IDs. Wonder
 * contributor suffixes distinguish CLI recipes; MSP always gets catalogue IDs. */
export function museModelRoute(id: string): {modelId:string;contributorMode:"on"|"off"} | undefined {
  if (["muse-spark-1.3", "muse-spark-1.3-contributor"].includes(id))
    return {modelId:id,contributorMode:"on"};
  for (const modelId of ["muse-wonder-1.0", "muse-wonder-full-1.0"]) {
    if (id === modelId) return {modelId,contributorMode:"off"};
    if (id === `${modelId}-contributor`) return {modelId,contributorMode:"on"};
  }
  return undefined;
}
export const isQualifiedMuseModel = (id:string) => museModelRoute(id) !== undefined;
export function museResponseIdentity(id:string) {
  const route = museModelRoute(id);
  if (!route) return {};
  if (route.modelId.startsWith("muse-spark-1.3"))
    return {responseModel:"muse-spark-1.3-contributor",responseModelSource:"derived:fixed-contributor-on-recipe",contributorMode:route.contributorMode,nativeModel:route.modelId};
  // model/list establishes logical selection, not physical response identity.
  return {responseModelSource:"unknown:physical-model-id;catalogue-logical-selection",contributorMode:route.contributorMode,nativeModel:route.modelId};
}
