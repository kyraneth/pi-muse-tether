export type MuseFeature = "rawLog" | "privatePrompt" | "sessionMcp" | "catalogue";
const observed = new Map<MuseFeature,{build:string;status:string;reason?:string}>();
export function featureNotice(build:string,feature:MuseFeature,reason:string,fallback:string) {
  observed.set(feature,{build,status:fallback,reason});
  return `[pi-muse-tether] ${JSON.stringify({code:"MUSE_FEATURE_DEGRADED",build,feature,reason,fallback,remedy:"/muse-doctor qualify [build]"})}`;
}
export function featureActive(build:string,feature:MuseFeature) { observed.set(feature,{build,status:"active"}); }
export const MUSE_FEATURE_CONTRACT = {
  rawLog:{stability:"experimental",check:"qualification evidence + initialize grant + recorded envelope and consumed payload schema",fallback:"sequential Pi tools; no replay"},
  privatePrompt:{stability:"experimental",check:"experimentalApi negotiation + session reviewer shape; exact instruction delivery attested by live qualification",fallback:"supported run.developer_prompt; appended, not replacement"},
  sessionMcp:{stability:"stable capability with experimental configuration",check:"initialize sessionMcp grant + session/start identity + inventory readiness/tool names",fallback:"typed refusal; Pi must own tools"},
  versionPolicy:{minimum:"protocol-compatible floor",testedRange:"declared evidence; ledger diagnostic above maximum",strict:"explicit opt-in refuses above maximum",updates:"vendor-owned; no production suppression"},
} as const;
export const museFeatureStatus = () => ({
  rawLog:{status:"not negotiated",fallback:"sequential unless qualified and granted"},
  privatePrompt:{status:"not negotiated",fallback:"append supported developer instructions"},
  sessionMcp:{status:"not negotiated",fallback:"refuse if unavailable"},
  ...Object.fromEntries(observed),
});
export class MuseFeatureUnavailable extends Error {
  readonly code="MUSE_FEATURE_UNAVAILABLE";
  constructor(readonly build:string,readonly feature:MuseFeature,readonly causeDescription:string) {
    super(`${featureNotice(build,feature,causeDescription,"refused: Pi must own tools")}; MUSE_FEATURE_UNAVAILABLE: run /muse-doctor qualify ${build}`);
  }
}
