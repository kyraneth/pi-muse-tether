import type { ReasoningEffort } from "./wire-types.js";
/** MSP SS3.2: explicit per-turn tier, never the client's configured default. */
export function museEffort(level?: string): ReasoningEffort {
  if (level === undefined || level === "off") return "none";
  if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
    return level as ReasoningEffort;
  throw new Error(`Unsupported Pi Muse thinking level: ${level}`);
}
/** Stream only vendor-exposed reasoning text/summary, never fabricate signatures. */
export function thinkingFrame(
  output: any,
  stream: any,
  frame: any,
  indexes: Map<string, number>,
) {
  const p = frame.params ?? {},
    item = p.item;
  const id = item?.itemId ?? p.itemId;
  if (item?.kind === "reasoning" && typeof id === "string" && !indexes.has(id))
    indexes.set(id, -1);
  if (!indexes.has(id) || indexes.get(id) === -2) return;
  const delta =
    frame.method === "item/delta" && /^summary\.\d+$/.test(p.field)
      ? p.delta
      : undefined;
  const committed = Array.isArray(item?.summary)
    ? item.summary.join("\n")
    : item?.text;
  // Raw reasoning is committed only; do not double-add summary + raw text.
  const text =
    typeof delta === "string"
      ? delta
      : frame.method === "item/completed" &&
          indexes.get(id) === -1 &&
          typeof committed === "string"
        ? committed
        : undefined;
  if (text) {
    let index = indexes.get(id)!;
    if (index === -1) {
      index = output.content.length;
      indexes.set(id, index);
      output.content.push({ type: "thinking", thinking: "" });
      stream.push({
        type: "thinking_start",
        contentIndex: index,
        partial: output,
      });
    }
    output.content[index].thinking += text;
    stream.push({
      type: "thinking_delta",
      contentIndex: index,
      delta: text,
      partial: output,
    });
  }
  if (frame.method === "item/completed" && indexes.get(id)! >= 0) {
    const index = indexes.get(id)!;
    stream.push({
      type: "thinking_end",
      contentIndex: index,
      content: output.content[index].thinking,
      partial: output,
    });
    indexes.set(id, -2);
  }
}

/** Offer only the official model/list tiers. Unknown is not a guessed ladder. */
export function museThinkingLevelMap(variants: unknown) {
  const tiers = Array.isArray(variants) ? variants : [];
  return Object.fromEntries(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => {
      const tier = museEffort(level);
      return [level, tiers.includes(tier) ? tier : null];
    }),
  );
}
