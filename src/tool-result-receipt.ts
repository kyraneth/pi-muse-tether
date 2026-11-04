import { createHash } from "node:crypto";
import type { BridgeResult } from "pi-tether-core/mcp/bridge";

/** Nonempty text parts join with one LF. Exactly [text, PNG image] adds
 * an image placeholder, NOT image bytes. Other rich layouts remain unqualified. */
export type UnverifiableImage = { partIndex: number; sha256: string; byteLen: number; mimeType: string };
function imageDeclaration(sent: BridgeResult): UnverifiableImage | undefined {
  if (sent.content.length !== 2 || sent.content[0]?.type !== "text" || !sent.content[0].text || sent.content[1]?.type !== "image" || sent.isError === true) return;
  const image = sent.content[1];
  if (image.mimeType !== "image/png" || !image.data) return;
  const bytes = Buffer.from(image.data, "base64");
  // Canonical base64 and the PNG signature prevent permissive Buffer decoding
  // from silently accepting malformed/foreign encodings before MCP delivery.
  if (bytes.toString("base64") !== image.data || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return;
  return { partIndex: 1, sha256: createHash("sha256").update(bytes).digest("hex"), byteLen: bytes.length, mimeType: image.mimeType };
}
export function assertToolResultVerifiable(sent: BridgeResult): void {
  const singleText = sent.content.length === 1 && sent.content[0]?.type === "text";
  const multiText = sent.isError !== true && sent.content.length > 1 && sent.content.every(p => p.type === "text" && p.text.length > 0);
  if (!singleText && !multiText && !imageDeclaration(sent)) {
    const kinds = sent.content.map(p => p.type).join(",");
    throw new Error(`Muse tool result cannot verify MCP parts [${kinds}]: MSP visibleOutput flattens text; modelVisibleContent exposes image metadata, not bytes or part boundaries`);
  }
}
export function toolResultReceipt(item: any, sent: BridgeResult, stored?: string, onRedactions?: (spans: VendorRedaction[]) => void, onImages?: (images: UnverifiableImage[]) => void): BridgeResult {
  assertToolResultVerifiable(sent);
  if (item.modelVisibleContent?.length) throw new Error("Muse text receipt unexpectedly contains modelVisibleContent");
  if (typeof item.visibleOutput !== "string") throw new Error("Muse tool result missing visibleOutput");
  if (item.truncated && stored === undefined) throw new Error("Muse truncated tool result has no verifiable full outputRef readback");
  const output = stored ?? item.visibleOutput;
  if (stored !== undefined) {
    if (item.truncated ? !stored.startsWith(item.visibleOutput) : stored !== item.visibleOutput)
      throw new Error("Muse stored tool output differs from visibleOutput");
  }
  if (sent.isError === true) {
    // ENOENT-style error frame: failed + verbatim failureReason; the display adds this prefix.
    if (item.status !== "failed" || item.failureKind !== undefined || typeof item.failureReason !== "string")
      throw new Error("Muse MCP error receipt requires failed status and verbatim failureReason without a host failureKind");
    if (output !== `tool failed: ${item.failureReason}`) throw new Error("Muse MCP error visibleOutput differs from failureReason");
    return reconcileVendorRedactions(sent, { content: [{ type: "text", text: item.failureReason }], isError: true }, onRedactions);
  }
  if (item.status !== "completed" || item.failureReason !== undefined || item.failureKind !== undefined)
    throw new Error("Muse successful MCP receipt has non-completed status or failure fields");
  if (sent.content.length === 1) return reconcileVendorRedactions(sent, { content: [{ type: "text", text: output }], isError: false }, onRedactions);
  const image = imageDeclaration(sent);
  if (image && !onImages) throw new Error("Muse image receipt requires declared-unverifiable reporting");
  // Verify the image placeholder BEFORE any redaction reconciliation. A vendor
  // marker may occur inside text parts only; it can never hide changed metadata.
  const suffix = image ? `\n[MCP image content: media_type=${image.mimeType}, bytes=${image.byteLen}]` : "";
  if (image && !output.endsWith(suffix)) throw new Error("Muse tool result image placeholder differs from Pi MIME/decoded byte length");
  const actualText = image ? output.slice(0, -suffix.length) : output;
  const expectedText = sent.content.filter(p => p.type === "text").map(p => p.text).join("\n");
  const projected: BridgeResult = {content:[{type:"text",text:expectedText}],isError:false};
  let redactions: VendorRedaction[] = [];
  const reconciled = reconcileVendorRedactions(projected, {content:[{type:"text",text:actualText}],isError:false}, spans => { redactions = spans; });
  if ((reconciled.content[0] as {text:string}).text !== expectedText) throw new Error("Muse tool result text projection mismatch");
  // Existing intraline alignment cannot cross a part's inserted LF boundary.
  // Spans address this ordered LF-joined text projection, never image bytes.
  if (redactions.length) onRedactions?.(redactions);
  if (image) onImages?.([image]);
  // Preserve the original Pi shape for its exact journal hash. Image bytes here
  // are declared UNVERIFIABLE; the callback/ledger must not claim consumption.
  return sent;
}

/** Byte offsets address original Pi text and the actual Muse text receipt.
 * Multipart offsets use LF-joined text parts (never the image placeholder).
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
  // nonempty single-line removed spans bounded on BOTH sides by exact text.
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
  function lineSpans(text: string, visible: string): Span[] {
    const pieces = visible.split(marker), n = text.length;
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
          const end = a + marker.length;
          current[a] = matches[end] ? next[end + chunk.length] ?? 0 : 0;
          if (current[a] === 1) choice[a] = -1; // literal marker, never a hole
        } else if (a > 0 && pieces[i].length && chunk.length && barrier[a] > a) {
          const ways = sum[a + 1] - sum[barrier[a] + 1];
          current[a] = Math.min(2, ways);
          if (ways === 1) choice[a] = first[a + 1];
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
      a = (end === -1 ? a + marker.length : end) + pieces[i + 1].length;
      b += marker.length + pieces[i + 1].length;
    }
    return spans;
  }
  const piLines = pi.split("\n"), museLines = muse.split("\n");
  if (piLines.length !== museLines.length) throw invalid();
  const aligned: Span[] = []; let piBase = 0, museBase = 0;
  for (let i = 0; i < piLines.length; i++) {
    if (piLines[i] !== museLines[i]) for (const s of lineSpans(piLines[i], museLines[i]))
      aligned.push({ piStart: piBase + s.piStart, piEnd: piBase + s.piEnd, museStart: museBase + s.museStart });
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
