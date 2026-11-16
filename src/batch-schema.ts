import { readFileSync } from "node:fs";
/** Retained structural schema definitions (documentation descriptions stripped
 * from this distributable projection), not a version-string allowlist. Meta's
 * envelope explicitly declares payload unstable/free-form: the consumed event
 * shape below is additionally checked from the two observed batch fixtures. */
const recorded = JSON.parse(readFileSync(new URL("../assets/batch-boundary-schemas.json", import.meta.url), "utf8"));
export const BATCH_SCHEMA_SOURCES: Array<{build:string;sha256:string}> = recorded.sources;
function matches(value: any, schema: any, defs: any): boolean {
  if (schema.$ref) return matches(value, defs[schema.$ref.split("/").at(-1)], defs);
  if (Array.isArray(schema.type)) return schema.type.some((type: string) => matches(value, {...schema,type}, defs));
  if (schema.type === "null") return value === null;
  if (schema.type === "integer") return Number.isSafeInteger(value);
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (schema.required?.some((key: string) => !(key in value))) return false;
    return Object.entries(schema.properties ?? {}).every(([key, child]) => !(key in value) || matches(value[key], child, defs));
  }
  return false; // Fail closed on schema constructs this owning subset does not use.
}
export function batchBoundarySchemaMatches(params: unknown): boolean {
  return recorded.schemas.some(({ $defs }: any) => matches(params, $defs.LogRecordParams, $defs) && matches((params as any).record, $defs.RawLogRecordEnvelope, $defs));
}
export function committedCalls(params: any): Array<{callId:string;name:string;args:Record<string,unknown>}> {
  if (!batchBoundarySchemaMatches(params)) throw new Error("Batch envelope schema mismatch");
  const payload=params.record.payload, event=payload?.event;
  if (payload?.kind !== "run" || typeof payload.run_id !== "string" || event?.kind !== "assistant_tool_calls_committed" || !Array.isArray(event.tool_calls) || !event.tool_calls.length) throw new Error("Batch payload schema mismatch");
  return event.tool_calls.map((call: any) => {
    const args=typeof call.args === "string" ? JSON.parse(call.args) : call.args;
    if (typeof call.call_id !== "string" || !call.call_id || typeof call.name !== "string" || !call.name || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Batch tool-call schema mismatch");
    return {callId:call.call_id,name:call.name,args};
  });
}
