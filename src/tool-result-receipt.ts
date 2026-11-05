import { createHash } from "node:crypto";
import type { BridgeResult } from "pi-tether-core/mcp/bridge";

/** MSP folds text chunks with LF boundaries and emits image metadata,
 * never an attestation of pixels. Keep original parts for the Pi journal. */
export type UnverifiableImage = { partIndex: number; sha256: string; byteLen: number; mimeType: string; modelVisibility?: "omitted-error-result" };
const imageMagic: Record<string, (b: Buffer) => boolean> = {
  "image/png": b => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
  "image/jpeg": b => b[0] === 255 && b[1] === 216 && b[2] === 255,
  "image/gif": b => ["GIF87a", "GIF89a"].includes(b.subarray(0,6).toString("ascii")),
  "image/webp": b => b.subarray(0,4).toString("ascii") === "RIFF" && b.subarray(8,12).toString("ascii") === "WEBP",
};
function imageDeclarations(sent: BridgeResult): UnverifiableImage[] {
  const images: UnverifiableImage[] = [];
  for (const [partIndex, part] of sent.content.entries()) {
    if (part.type === "text" && typeof part.text === "string") continue;
    if (part.type !== "image" || !part.data || !imageMagic[part.mimeType])
      throw new Error("Muse tool result cannot verify MCP parts: unsupported image or content type");
    const bytes = Buffer.from(part.data, "base64");
    if (bytes.toString("base64") !== part.data || !imageMagic[part.mimeType](bytes))
      throw new Error("Muse tool result cannot verify MCP parts: malformed image encoding or MIME signature");
    images.push({ partIndex, sha256: createHash("sha256").update(bytes).digest("hex"), byteLen: bytes.length, mimeType: part.mimeType,
      ...(sent.isError === true ? {modelVisibility: "omitted-error-result" as const} : {}) });
  }
  return images;
}
export function assertToolResultVerifiable(sent: BridgeResult): void {
  imageDeclarations(sent);
}
export function toolResultReceipt(item: any, sent: BridgeResult, stored?: string, onRedactions?: (spans: VendorRedaction[]) => void, onImages?: (images: UnverifiableImage[]) => void): BridgeResult {
  const images = imageDeclarations(sent);
  if (images.length && !onImages) throw new Error("Muse image receipt requires declared-unverifiable reporting");
  if (typeof item.visibleOutput !== "string") throw new Error("Muse tool result missing visibleOutput");
  if (item.truncated && stored === undefined) throw new Error("Muse truncated tool result has no verifiable full outputRef readback");
  const output = stored ?? item.visibleOutput;
  if (stored !== undefined && (item.truncated ? !stored.startsWith(item.visibleOutput) : stored !== item.visibleOutput))
    throw new Error("Muse stored tool output differs from visibleOutput");
  let actual = output;
  if (sent.isError === true) {
    if (item.status !== "failed" || item.failureKind !== undefined || typeof item.failureReason !== "string")
      throw new Error("Muse MCP error receipt requires failed status and verbatim failureReason without a host failureKind");
    if (output !== `tool failed: ${item.failureReason}`) throw new Error("Muse MCP error visibleOutput differs from failureReason");
    actual = item.failureReason;
  } else if (item.status !== "completed" || item.failureReason !== undefined || item.failureKind !== undefined) {
    throw new Error("Muse successful MCP receipt has non-completed status or failure fields");
  }
  // Construct the ordered native projection from Pi parts. Never search/remove
  // placeholder-shaped strings: literal tool text and leading LF remain bytes.
  let expected = "";
  const protectedImages: { start: number; end: number }[] = [];
  for (const [index, part] of sent.content.entries()) {
    if (part.type === "text") {
      // Native string folding ignores leading empty chunks but preserves a
      // separator before an empty chunk after nonempty output (captured live).
      expected += (expected ? "\n" : "") + part.text;
    } else {
      // The official client's failed MCP path projects text only. Images were
      // delivered to MCP, NOT exposed to the model; declare that known loss.
      if (sent.isError === true) continue;
      const image = images.find(image => image.partIndex === index)!;
      if (expected) expected += "\n";
      const start = expected.length;
      expected += `[MCP image content: media_type=${image.mimeType}, bytes=${image.byteLen}]`;
      protectedImages.push({ start, end: expected.length });
    }
  }
  // Failed MCP results use a separate native codec: all text parts are
  // LF-joined (including leading empties), and images are dropped.
  if (sent.isError === true) {
    expected = sent.content.filter(part => part.type === "text").map(part => (part as {text:string}).text).join("\n");
    if (!expected) expected = "MCP tool returned an error";
  } else if (!expected) expected = "[MCP tool returned no content]";
  const projected: BridgeResult = { content: [{ type: "text", text: expected }], isError: sent.isError === true };
  let redactions: VendorRedaction[] = [];
  const observed = reconcileVendorRedactions(projected, { content: [{ type: "text", text: actual }], isError: sent.isError === true }, spans => { redactions = spans; });
  if ((observed.content[0] as { text: string }).text !== expected)
    throw new Error("Muse tool result text projection mismatch (image placeholder differs or text changed)");
  for (const span of redactions) {
    if (protectedImages.some(range => span.piOffsetBytes < Buffer.byteLength(expected.slice(0, range.end)) &&
      span.piOffsetBytes + span.piByteLen > Buffer.byteLength(expected.slice(0, range.start))))
      throw new Error("Muse image placeholder differs: redaction cannot hide image metadata");
  }
  if (redactions.length) onRedactions?.(redactions);
  if (images.length) onImages?.(images);
  // modelVisibleContent may contain image derivatives or metadata. It is useful
  // evidence of delivery but never upgrades these declarations to exact pixels.
  return sent;
}

/** Byte offsets address the constructed native Pi-parts projection and the
 * actual Muse receipt. Image metadata occupies protected positions in this
 * projection; no declared loss may cover those positions.
 * Never include removed text in metadata. This is declared vendor loss, NOT
 * proof that the model consumed the original bytes. */
export type VendorRedaction = { piOffsetBytes: number; museOffsetBytes: number; piByteLen: number; sha256: string };
const marker = "[REDACTED]";
function reconcileVendorRedactions(sent: BridgeResult, observed: BridgeResult, report?: (spans: VendorRedaction[]) => void): BridgeResult {
  const pi = (sent.content[0] as {text:string}).text;
  const muse = (observed.content[0] as {text:string}).text;
  if (pi === muse || !muse.includes(marker)) return observed;
  // DECLARED LOSSY TRANSPORT ACCEPTANCE, not verification of removed bytes.
  // The pinned binary exposes the marker and token prefixes, but not a complete
  // provable runtime pattern set. Conservative fallback: unique alignment,
  // nonempty single-line removed spans with unique positional alignment, including line edges.
  // Literal Pi markers must match literally and may never be swallowed by a gap.
  type Span = { piStart: number; piEnd: number; museStart: number };
  const invalid = () => new Error("Muse tool result mismatch: invalid or ambiguous vendor redaction");
  // Match literal chunks with KMP, not a fresh suffix scan at every candidate.
  function starts(text: string, chunk: string): Uint8Array {
    const found = new Uint8Array(text.length + 1);
    if (!chunk.length) { found.fill(1); return found; }
    const prefix = new Int32Array(chunk.length);
    for (let i = 1, j = 0; i < chunk.length; i++) {
      while (j && chunk[i] !== chunk[j]) j = prefix[j - 1];
      if (chunk[i] === chunk[j]) j++;
      prefix[i] = j;
    }
    for (let i = 0, j = 0; i < text.length; i++) {
      while (j && text[i] !== chunk[j]) j = prefix[j - 1];
      if (text[i] === chunk[j]) j++;
      if (j === chunk.length) { found[i - j + 1] = 1; j = prefix[j - 1]; }
    }
    return found;
  }
  function lineSpans(text: string, visible: string, groupAdjacent = true): Span[] {
    // Adjacent vendor markers declare one combined loss region. Their internal
    // split is unknowable; the combined nonempty region still aligns uniquely.
    const pieces: string[] = [], widths: number[] = [];
    let cursor = 0, at: number;
    while ((at = visible.indexOf(marker, cursor)) !== -1) {
      pieces.push(visible.slice(cursor, at));
      cursor = at;
      let width = 0;
      while (visible.startsWith(marker, cursor)) {
        width++; cursor += marker.length;
        if (!groupAdjacent) break;
      }
      widths.push(width);
    }
    pieces.push(visible.slice(cursor));
    const n = text.length;
    if (pieces.length === 1 || !text.startsWith(pieces[0])) throw invalid();
    // Each backward layer counts complete parses after one marker. Range sums
    // make a variable-length hole O(1) per position: O(n * markerCount), not
    // quadratic suffix rescanning for a single gap. 2 means ambiguous, not a cap.
    const barrier = new Int32Array(n + 1); barrier[n] = n;
    for (let a = n - 1; a >= 0; a--)
      barrier[a] = text[a] === "\r" || text.startsWith(marker, a) ? a : barrier[a + 1];
    let next = new Uint8Array(n + 1); next[n] = 1;
    const choices: Int32Array[] = [];
    for (let i = pieces.length - 2; i >= 0; i--) {
      const chunk = pieces[i + 1], matches = starts(text, chunk);
      const sum = new Float64Array(n + 2), first = new Int32Array(n + 2); first.fill(-1);
      for (let a = n; a >= 0; a--) {
        const ways = matches[a] ? next[a + chunk.length] ?? 0 : 0;
        sum[a] = sum[a + 1] + ways;
        first[a] = ways ? a : first[a + 1];
      }
      const current = new Uint8Array(n + 1), choice = new Int32Array(n + 1); choice.fill(-2);
      for (let a = 0; a <= n; a++) {
        if (text.startsWith(marker, a)) {
          const end = a + marker.length * widths[i];
          if (!text.startsWith(marker.repeat(widths[i]), a)) continue;
          current[a] = matches[end] ? next[end + chunk.length] ?? 0 : 0;
          if (current[a] === 1) choice[a] = -1; // literal marker, never a hole
        } else if (barrier[a] > a) {
          const minimumEnd = a + 1;
          if (minimumEnd > barrier[a]) continue;
          const ways = sum[minimumEnd] - sum[barrier[a] + 1];
          current[a] = Math.min(2, ways);
          if (ways === 1) choice[a] = first[minimumEnd];
        }
      }
      choices[i] = choice; next = current;
    }
    let a = pieces[0].length, b = a;
    if (next[a] !== 1) throw invalid();
    const spans: Span[] = [];
    for (let i = 0; i < choices.length; i++) {
      const end = choices[i][a];
      if (end >= 0) spans.push({ piStart: a, piEnd: end, museStart: b });
      a = (end === -1 ? a + marker.length * widths[i] : end) + pieces[i + 1].length;
      b += marker.length * widths[i] + pieces[i + 1].length;
    }
    return spans;
  }
  const piLines = pi.split("\n"), museLines = muse.split("\n");
  if (piLines.length !== museLines.length) throw invalid();
  const aligned: Span[] = []; let piBase = 0, museBase = 0;
  for (let i = 0; i < piLines.length; i++) {
    if (piLines[i] !== museLines[i]) {
      let spans: Span[];
      try { spans = lineSpans(piLines[i], museLines[i]); }
      catch (error) {
        // A contiguous visible marker run may mix exact literal Pi markers
        // with a redaction beside them. Retry individual tokens only when Pi
        // actually contains a literal; require the same unique alignment.
        if (!piLines[i].includes(marker)) throw error;
        spans = lineSpans(piLines[i], museLines[i], false);
      }
      for (const s of spans)
        aligned.push({ piStart: piBase + s.piStart, piEnd: piBase + s.piEnd, museStart: museBase + s.museStart });
    }
    piBase += piLines[i].length + 1; museBase += museLines[i].length + 1;
  }
  if (!aligned.length) throw invalid();
  const spans = aligned.map(s => ({
    piOffsetBytes: Buffer.byteLength(pi.slice(0, s.piStart)),
    museOffsetBytes: Buffer.byteLength(muse.slice(0, s.museStart)),
    piByteLen: Buffer.byteLength(pi.slice(s.piStart, s.piEnd)),
    sha256: createHash("sha256").update(pi.slice(s.piStart, s.piEnd)).digest("hex"),
  }));
  // Reconstruct only after proving every byte outside the declared holes. The
  // bridge's original journal hash remains exact; the separate ledger records
  // that the actual vendor receipt contained holes, never exact consumption.
  report?.(spans);
  return { content: [{type:"text",text:pi}], isError: observed.isError };
}

export type OutputPage = { byteLen: number; content: string; encoding: string; eof: boolean; mediaType: string; offsetBytes: number };
/** Read-only SDK item/readOutput; no local path/URI reads or invented page caps.
 * Verifies stored text bytes, NOT an independent inference-provider payload. */
export async function readStoredToolOutput(item: any, read: (offsetBytes: number) => Promise<unknown>): Promise<string> {
  const ref = item.outputRef;
  if (!ref || ref.availability !== "available" || typeof ref.id !== "string" || !ref.id || !Number.isSafeInteger(ref.byteLen) || ref.byteLen < 0)
    throw new Error(`Muse tool outputRef unavailable or invalid: ${ref?.availability ?? "absent"}`);
  if (ref.mediaType !== undefined && ref.mediaType !== "text/plain") throw new Error(`Muse stored output mediaType unsupported: ${ref.mediaType}`);
  let offset = 0;
  const chunks: Buffer[] = [];
  while (true) {
    // Connection.request returns Record<string, unknown>; validate the wire at
    // this owning boundary before interpreting SDK 1.4.14 ItemReadOutputResult.
    const value = await read(offset);
    if (!value || typeof value !== "object" || typeof (value as any).content !== "string")
      throw new Error("Muse item/readOutput missing text content");
    const page = value as OutputPage;
    const bytes = Buffer.from(page.content, "utf8");
    if (page.encoding !== "utf8" || page.mediaType !== "text/plain" || page.offsetBytes !== offset ||
        !Number.isSafeInteger(page.byteLen) || page.byteLen !== bytes.length || typeof page.eof !== "boolean" ||
        offset + page.byteLen > ref.byteLen || (!page.eof && page.byteLen === 0))
      throw new Error("Muse item/readOutput invalid encoding, media type, byte range or non-progress page");
    chunks.push(bytes); offset += page.byteLen;
    if (page.eof) break;
  }
  if (offset !== ref.byteLen) throw new Error("Muse item/readOutput ended before outputRef byteLen");
  const bytes = Buffer.concat(chunks);
  if (ref.digest !== undefined) {
    if (ref.digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`)
      throw new Error("Muse outputRef digest unsupported or mismatched");
  }
  return bytes.toString("utf8");
}
