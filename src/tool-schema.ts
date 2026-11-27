/**
 * The Muse provider API rejects any tool parameter JSON schema whose total
 * enum values across all `enum` properties exceed 3,000. Vendor-imposed, not
 * chosen here: observed 2026-11-20 against the Muse provider API as
 * `API error 400: JSON schema exceeds the maximum of 3000 total enum values
 * across all enum properties (invalid_request_error) [param=parameters]`
 * (~3,750 enum values rejected; half-size payload accepted).
 */
export const MUSE_TOOL_SCHEMA_ENUM_LIMIT = 3_000;

/** Count total values across every `enum` array inside a JSON Schema object. */
export function countSchemaEnumValues(schema: unknown, seen = new Set<object>()): number {
  if (!schema || typeof schema !== "object") return 0;
  if (seen.has(schema)) return 0;
  seen.add(schema);
  if (Array.isArray(schema)) {
    let total = 0;
    for (const item of schema) total += countSchemaEnumValues(item, seen);
    return total;
  }
  let total = 0;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "enum" && Array.isArray(value)) {
      total += value.length;
    } else if (value && typeof value === "object") {
      total += countSchemaEnumValues(value, seen);
    }
  }
  return total;
}

/** Nothing was submitted: the provider API rejects schemas above this enum cap. */
export class MuseToolSchemaEnumLimitError extends Error {
  readonly code = "MUSE_TOOL_SCHEMA_ENUM_LIMIT";
  constructor(
    readonly toolName: string,
    readonly enumCount: number,
    readonly limit: number = MUSE_TOOL_SCHEMA_ENUM_LIMIT,
  ) {
    super(
      `Muse request not sent: tool "${toolName}" JSON schema has ${enumCount} total enum values, exceeding the provider limit of ${limit} total enum values across all enum properties (source: observed 2026-11-20 from the Muse provider API as HTTP 400 invalid_request_error [param=parameters]). Simplify or split the schema and retry; nothing was submitted.`,
    );
  }
}

export function assertToolSchemasWithinEnumLimit(
  tools: ReadonlyArray<{ name: string; inputSchema: unknown }>,
  limit: number = MUSE_TOOL_SCHEMA_ENUM_LIMIT,
): void {
  for (const tool of tools) {
    const count = countSchemaEnumValues(tool.inputSchema);
    if (count > limit) throw new MuseToolSchemaEnumLimitError(tool.name, count, limit);
  }
}
