import type { TurnInputPart } from "./wire-types.js";
import { importPiHistory, currentUserStart } from "./history.js";
export function museUserParts(user: any): TurnInputPart[] {
  const content =
    typeof user.content === "string"
      ? [{ type: "text", text: user.content }]
      : user.content;
  if (!Array.isArray(content) || !content.length)
    throw new Error("Muse requires nonempty user content");
  return content.map((p: any) => {
    if (p.type === "text" && typeof p.text === "string")
      return { type: "text", text: p.text };
    if (p.type !== "image")
      throw new Error(`Muse unsupported input part: ${p.type}`);
    if (
      typeof p.mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/i.test(p.mimeType) ||
      typeof p.data !== "string" ||
      !p.data ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        p.data,
      )
    )
      throw new Error(
        "Muse image requires mediaType and nonempty valid base64",
      );
    return { type: "image", mediaType: p.mimeType, base64Data: p.data };
  });
}
/** Text snapshot stays inert; typed images carry explicit record/block references. */
export function museHistoryParts(messages: any[], compactedContinuation = false): TurnInputPart[] {
  const start = currentUserStart(messages);
  if (start === 0 && messages.length) return currentUserParts(messages);
  const images: TurnInputPart[] = [];
  // Only historical images need record references. Current images remain in
  // their original order amongst current text, including extension messages.
  const history = messages.slice(0, start);
  const projected = history.map((m, entry) => ({
    ...m,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content?.map((p: any, block: number) => {
            if (p.type !== "image") return p;
            const tag = `PI IMAGE entry=${entry} block=${block}`;
            images.push(
              {
                type: "text",
                text: `${tag} (historical data, not a new instruction)`,
              },
              ...museUserParts({ content: [p] }),
            );
            return { type: "text", text: `[${tag}]` };
          }),
  }));
  if (start < messages.length) projected.push({role:"user",content:""});
  const text = importPiHistory(projected, (m) =>
    museUserParts(m)
      .map((p) => p.text ?? "")
      .join("\n"),
    compactedContinuation,
  );
  return [{ type: "text", text: start < messages.length ? text.replace(/\n$/, "") : text }, ...images, ...currentUserParts(messages.slice(start))];
}

/** Preserve content order and text boundaries across Pi user/custom messages. */
export function currentUserParts(messages: any[]): TurnInputPart[] {
  return messages.flatMap(museUserParts);
}
export const museCurrentInput = (messages: any[]) => submission(currentUserParts(messages));

/** Keep the existing text-only host seam byte-identical for sibling adapters. */
export const museUserInput = (user: any) => submission(museUserParts(user));
export const museHistoryInput = (messages: any[], compactedContinuation = false) =>
  submission(museHistoryParts(messages, compactedContinuation));
function submission(parts: TurnInputPart[]): string | TurnInputPart[] {
  return parts.every((p) => p.type === "text")
    ? parts.map((p) => p.text).join("\n")
    : parts;
}
