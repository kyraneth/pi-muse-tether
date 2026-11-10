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
/** visibleBytes includes any displayed ellipsis; candidate offsets address the original projection. */
export type TruncatedView = { visibleBytes: number; projectionBytes: number; omittedOffsetBytes: number; omittedByteLen: number; sha256: string; ellipsisIdentity: "not-present" | "generated" | "ambiguous"; candidateOmittedOffsetsBytes: number[]; sources: {partIndex:number;partOffsetBytes:number;byteLen:number}[] };
/** MSP 1.4.14 live capture: 65,536 view bytes ended with U+2026, after an
 * exact 65,533-byte original prefix. These observed lengths are not limits. */
function viewPrefixes(visible: string, full: string): string[] {
  const candidates = [visible, ...(visible.endsWith("…") ? [visible.slice(0,-1)] : [])];
  return candidates.filter(prefix => !(prefix.length && /[\uD800-\uDBFF]/.test(prefix.at(-1)!)) && full.startsWith(prefix));
}
export function toolResultReceipt(item: any, sent: BridgeResult, stored?: string, onRedactions?: (spans: VendorRedaction[]) => void, onImages?: (images: UnverifiableImage[]) => void, onTruncatedView?: (view: TruncatedView) => void): BridgeResult {
  const images = imageDeclarations(sent);
  if (images.length && !onImages) throw new Error("Muse image receipt requires declared-unverifiable reporting");
  if (typeof item.visibleOutput !== "string") throw new Error("Muse tool result missing visibleOutput");
  if (item.truncated !== undefined && typeof item.truncated !== "boolean")
    throw new Error("Muse tool result truncated flag must be boolean");
  const partial = item.truncated === true && stored === undefined;
  if (partial && item.outputRef !== undefined && (!item.outputRef || !["missing","unsupported","accessFailed"].includes(item.outputRef.availability)))
    throw new Error("Muse truncated view outputRef requires strict readback or known unavailability");
  if (partial && (!onTruncatedView || sent.isError === true || images.length))
    throw new Error("Muse truncated view requires full readback for this result shape");
  const output = stored ?? item.visibleOutput;
  if (stored !== undefined && (item.truncated ? viewPrefixes(item.visibleOutput,stored).length === 0 : stored !== item.visibleOutput))
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
  const textSources: {partIndex:number; start:number; end:number}[] = [];
  for (const [index, part] of sent.content.entries()) {
    if (part.type === "text") {
      // Native string folding ignores leading empty chunks but preserves a
      // separator before an empty chunk after nonempty output (captured live).
      if (expected) expected += "\n";
      const start = Buffer.byteLength(expected);
      expected += part.text;
      textSources.push({partIndex:index,start,end:Buffer.byteLength(expected)});
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
    textSources.length=0;
    let offset=0;
    for(const [partIndex,part] of sent.content.entries()) if(part.type==="text") {
      textSources.push({partIndex,start:offset,end:offset+Buffer.byteLength(part.text)});
      offset+=Buffer.byteLength(part.text)+1;
    }
  } else if (!expected) expected = "[MCP tool returned no content]";
  const locateSources=(redactions:VendorRedaction[])=>{
    for(const span of redactions) span.sources=textSources.filter(s=>s.start<span.piOffsetBytes+span.piByteLen && s.end>span.piOffsetBytes).map(s=>({partIndex:s.partIndex,partOffsetBytes:Math.max(s.start,span.piOffsetBytes)-s.start,byteLen:Math.min(s.end,span.piOffsetBytes+span.piByteLen)-Math.max(s.start,span.piOffsetBytes)}));
  };
  if (partial) {
    // The captured combined codec preserves line boundaries. Reconcile
    // complete lines normally and the final line with the same v4 positional
    // alignment in prefix mode, retaining every viable original cut.
    const visibleEnd=actual.lastIndexOf("\n")+1;
    let originalEnd=0;
    for(let at=0;at<visibleEnd;at++) if(actual[at]==="\n") {
      const next=expected.indexOf("\n",originalEnd);
      if(next<0) throw new Error("Muse truncated view has more lines than native projection");
      originalEnd=next+1;
    }
    const completeExpected=expected.slice(0,originalEnd),completeVisible=actual.slice(0,visibleEnd);
    const projected:BridgeResult={content:[{type:"text",text:completeExpected}],isError:false};
    let redactions:VendorRedaction[]=[];
    const observed=reconcileVendorRedactions(projected,{content:[{type:"text",text:completeVisible}],isError:false},spans=>{redactions=spans;});
    if ((observed.content[0] as {text:string}).text!==completeExpected)
      throw new Error("Muse truncated view complete lines differ from native projection");
    if(redactions.length && !onRedactions) throw new Error("Muse truncated view requires declared-redaction reporting");
    const finalVisible=actual.slice(visibleEnd),finalExpected=expected.slice(originalEnd).split("\n",1)[0];
    let finalSpans:VendorRedaction[]=[],prefix:PrefixAlignment|undefined;
    reconcileVendorRedactions({content:[{type:"text",text:finalExpected}],isError:false},
      {content:[{type:"text",text:finalVisible}],isError:false},spans=>{finalSpans=spans;},alignment=>{prefix=alignment;});
    if(!prefix) throw new Error("Muse truncated view differs from native projection prefix");
    const baseBytes=Buffer.byteLength(completeExpected),viewBaseBytes=Buffer.byteLength(completeVisible);
    for(const span of finalSpans) {
      span.piOffsetBytes+=baseBytes;span.museOffsetBytes+=viewBaseBytes;
      if(span.candidateStartBytes)span.candidateStartBytes=span.candidateStartBytes.map(offset=>offset+baseBytes);
      if(span.candidateEndBytes)span.candidateEndBytes=span.candidateEndBytes.map(offset=>offset+baseBytes);
    }
    redactions.push(...finalSpans);
    if(redactions.length && !onRedactions) throw new Error("Muse truncated view requires declared-redaction reporting");
    const candidateOmittedOffsetsBytes=prefix.cuts.map(cut=>baseBytes+Buffer.byteLength(finalExpected.slice(0,cut))).sort((a,b)=>a-b);
    const omittedOffsetBytes=candidateOmittedOffsetsBytes[0], projectionBytes=Buffer.byteLength(expected);
    const ellipsisIdentity=prefix.ellipsisIdentity;
    const omitted = Buffer.from(expected, "utf8").subarray(omittedOffsetBytes);
    locateSources(redactions);
    // Both checks succeeded; publish no partial evidence on a rejected view.
    if(redactions.length) onRedactions!(redactions);
    onTruncatedView!({visibleBytes:Buffer.byteLength(item.visibleOutput),projectionBytes,omittedOffsetBytes,
      omittedByteLen:omitted.length,sha256:createHash("sha256").update(omitted).digest("hex"),ellipsisIdentity,candidateOmittedOffsetsBytes,
      sources:textSources.filter(s=>s.end>omittedOffsetBytes).map(s=>({partIndex:s.partIndex,
        partOffsetBytes:Math.max(s.start,omittedOffsetBytes)-s.start,byteLen:s.end-Math.max(s.start,omittedOffsetBytes)}))});
    return sent;
  }
  const projected: BridgeResult = { content: [{ type: "text", text: expected }], isError: sent.isError === true };
  let redactions: VendorRedaction[] = [];
  const observed = reconcileVendorRedactions(projected, { content: [{ type: "text", text: actual }], isError: sent.isError === true }, spans => { redactions = spans; });
  if ((observed.content[0] as { text: string }).text !== expected) {
    let at=0;
    while(at<expected.length && at<actual.length && expected[at]===actual[at])at++;
    throw new Error(`Muse tool result text projection mismatch (image placeholder differs or text changed) at projection byte ${Buffer.byteLength(expected.slice(0,at))}, receipt byte ${Buffer.byteLength(actual.slice(0,at))}`);
  }
  for (const span of redactions) {
    if (protectedImages.some(range => span.piOffsetBytes < Buffer.byteLength(expected.slice(0, range.end)) &&
      span.piOffsetBytes + span.piByteLen > Buffer.byteLength(expected.slice(0, range.start))))
      throw new Error("Muse image placeholder differs: redaction cannot hide image metadata");
  }
  locateSources(redactions);
  if (redactions.length) onRedactions?.(redactions);
  if (images.length) onImages?.(images);
  // modelVisibleContent may contain image derivatives or metadata. It is useful
  // evidence of delivery but never upgrades these declarations to exact pixels.
  return sent;
}

/** Offsets address UTF-8 bytes in the native projection and vendor receipt.
 * Ambiguous spans cover the union of viable alignments, not an invented exact
 * removal. Hashes describe that source range; removed bytes are never logged. */
export type VendorRedaction = {
  piOffsetBytes: number; museOffsetBytes: number; piByteLen: number; sha256: string;
  reason: "vendor-redaction" | "ambiguous-vendor-redaction" | "vendor-bearer-prefix";
  alignment: "unique" | "ambiguous";
  ambiguityReason?: "multiple-alignments" | "literal-marker-identity";
  sources?: {partIndex:number;partOffsetBytes:number;byteLen:number}[];
  candidateStartBytes?: number[]; candidateEndBytes?: number[];
};
const marker = "[REDACTED]";
type PrefixAlignment={cuts:number[];ellipsisIdentity:TruncatedView["ellipsisIdentity"]};
function reconcileVendorRedactions(sent: BridgeResult, observed: BridgeResult, report?: (spans: VendorRedaction[]) => void, onPrefix?: (alignment:PrefixAlignment)=>void): BridgeResult {
  const pi = (sent.content[0] as {text:string}).text;
  const muse = (observed.content[0] as {text:string}).text;
  if(onPrefix && !muse.includes(marker)) {
    const prefixes=viewPrefixes(muse,pi);
    if(!prefixes.length) throw new Error("Muse truncated view differs from native projection prefix");
    onPrefix({cuts:prefixes.map(p=>p.length),ellipsisIdentity:muse.endsWith("…") ? prefixes.length===2 ? "ambiguous" : "generated" : "not-present"});
    return sent;
  }
  if (!onPrefix && (pi === muse || !muse.includes(marker))) return observed;
  const invalid = (piAt: number, museAt: number) => new Error(`Muse tool result mismatch: invalid vendor redaction at projection byte ${Buffer.byteLength(pi.slice(0, piAt))}, receipt byte ${Buffer.byteLength(muse.slice(0, museAt))}`);
  const spans: VendorRedaction[] = [];
  function record(start: number, end: number, visible: number, reason: VendorRedaction["reason"], alignment: VendorRedaction["alignment"], candidates?: {starts:number[];ends:number[]}) {
    spans.push({piOffsetBytes:Buffer.byteLength(pi.slice(0,start)),museOffsetBytes:Buffer.byteLength(muse.slice(0,visible)),
      piByteLen:Buffer.byteLength(pi.slice(start,end)),sha256:createHash("sha256").update(pi.slice(start,end)).digest("hex"),reason,alignment,
      ...(candidates ? {candidateStartBytes:candidates.starts.map(a=>Buffer.byteLength(pi.slice(0,a))),candidateEndBytes:candidates.ends.map(a=>Buffer.byteLength(pi.slice(0,a)))} : {})});
  }
  // KMP keeps literal matching linear in the source length per marker.
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
  function line(text: string, visible: string, piBase: number, museBase: number) {
    const pieces: string[] = [], widths: number[] = [], positions: number[] = [];
    let cursor = 0, at: number;
    while ((at = visible.indexOf(marker, cursor)) !== -1) {
      pieces.push(visible.slice(cursor, at)); positions.push(at); cursor = at;
      let width = 0;
      while (visible.startsWith(marker, cursor)) { width++; cursor += marker.length; }
      widths.push(width);
    }
    pieces.push(visible.slice(cursor));
    const n = text.length, count = widths.length;
    const boundary=(at:number)=>!(at>0 && at<n && /[\uD800-\uDBFF]/.test(text[at-1]) && /[\uDC00-\uDFFF]/.test(text[at]));
    if (!count || !boundary(pieces[0].length)) throw invalid(piBase, museBase);
    const matches = pieces.map((chunk,i) => {
      const exact = starts(text, chunk);
      // Captured official-client codec: `bearer permission.` becomes
      // `Bearer [REDACTED]`. ONLY the prefix immediately before a marker is
      // case-folded; no other text/case/status/metadata normalization is allowed.
      if (i < count && chunk.endsWith("Bearer ")) {
        const prefix = chunk.slice(0,-7), candidates = starts(text,prefix);
        for(let a=0;a+chunk.length<=n;a++)
          if(candidates[a] && text.slice(a+prefix.length,a+chunk.length).toLowerCase()==="bearer ") exact[a]=1;
      }
      return exact;
    });
    if (!matches[0][0]) throw invalid(piBase, museBase);
    // Backward feasibility. A marker declares a nonempty single-line hole.
    // Literal marker text is allowed inside a hole: when that loses identity,
    // the evidence is ambiguous, never silently claimed exact or made fatal.
    const layers: Uint8Array[] = [];
    let next = new Uint8Array(n+1); if(onPrefix)next.fill(1);else next[n]=1;
    const last=pieces[count],shortLast=onPrefix && last.endsWith("…") ? last.slice(0,-1) : undefined;
    const shortMatches=shortLast===undefined ? undefined : starts(text,shortLast);
    for(let i=count-1;i>=0;i--) {
      const chunk=pieces[i+1], viable=new Uint8Array(n+1);
      for(let end=0;end<=n;end++)
        viable[end]=boundary(end) && ((end+chunk.length<=n && matches[i+1][end] && boundary(end+chunk.length) && next[end+chunk.length]) ||
          (i===count-1 && shortLast!==undefined && end+shortLast.length<=n && shortMatches![end] && boundary(end+shortLast.length) && next[end+shortLast.length])) ? 1 : 0;
      layers[i]=viable;
      const current=new Uint8Array(n+1); let found=false;
      for(let a=n;a>=0;a--) {
        // CR is a line boundary too, not something a declared hole may hide.
        if(text[a]==="\r") found=false;
        current[a]=found?1:0;
        if(viable[a]) found=true;
      }
      next=current;
    }
    if(!next[pieces[0].length]) throw invalid(piBase, museBase);
    // Forward reachable starts plus backward viable ends give all candidate
    // boundaries without enumerating exponentially many complete parses.
    let reachable=new Uint8Array(n+1);reachable[pieces[0].length]=1;
    for(let i=0;i<count;i++) {
      const viable=layers[i], chunk=pieces[i+1];
      const candidateStarts:number[]=[], candidateEnds:number[]=[];
      let lastEnd=-1;
      for(let a=n;a>=0;a--) {
        if(text[a]==="\r") lastEnd=-1;
        if(reachable[a] && lastEnd>a) candidateStarts.push(a);
        if(viable[a]) lastEnd=a;
      }
      candidateStarts.reverse();
      let seen=false;
      const following=new Uint8Array(n+1);let fullCut=false,shortCut=false;
      for(let end=0;end<=n;end++) {
        if(text[end-1]==="\r") seen=false;
        if(end>0 && reachable[end-1] && text[end-1]!=="\r") seen=true;
        if(seen && viable[end]) {
          candidateEnds.push(end);
          if(i===count-1 && onPrefix) {
            if(end+chunk.length<=n && matches[i+1][end] && boundary(end+chunk.length) && !(end+chunk.length>0 && /[\uD800-\uDBFF]/.test(text[end+chunk.length-1]))) {following[end+chunk.length]=1;fullCut=true;}
            if(shortLast!==undefined && end+shortLast.length<=n && shortMatches![end] && boundary(end+shortLast.length) && !(end+shortLast.length>0 && /[\uD800-\uDBFF]/.test(text[end+shortLast.length-1]))) {following[end+shortLast.length]=1;shortCut=true;}
          } else following[end+chunk.length]=1;
        }
      }
      const multiple=candidateStarts.length!==1 || candidateEnds.length!==1;
      const start=candidateStarts[0], end=candidateEnds.at(-1)!;
      const literal=!multiple && text.slice(start,end)===marker.repeat(widths[i]);
      const literalIdentity=!literal && text.slice(start,end).includes(marker);
      const ambiguous=multiple || literalIdentity;
      if(!literal)record(piBase+start,piBase+end,museBase+positions[i],ambiguous?"ambiguous-vendor-redaction":"vendor-redaction",ambiguous?"ambiguous":"unique",
        ambiguous?{starts:candidateStarts.map(a=>piBase+a),ends:candidateEnds.map(a=>piBase+a)}:undefined);
      if(!literal && ambiguous)spans.at(-1)!.ambiguityReason=multiple?"multiple-alignments":"literal-marker-identity";
      // A canonicalized Bearer prefix belongs to the same declared codec loss,
      // with its own exact source range (not hidden in the redaction's hash).
      const prior=pieces[i];
      if(prior.endsWith("Bearer ")) {
        for(const a of candidateStarts) {
          const p=a-7;
          if(text.slice(p,a)!=="Bearer ")record(piBase+p,piBase+a,museBase+positions[i]-7,"vendor-bearer-prefix",ambiguous?"ambiguous":"unique");
        }
      }
      reachable=following;
      if(i===count-1 && onPrefix) {
        const cuts:number[]=[];
        for(let cut=0;cut<=n;cut++)if(following[cut] && !(cut>0 && /[\uD800-\uDBFF]/.test(text[cut-1])))cuts.push(cut);
        if(!cuts.length)throw invalid(piBase,museBase);
        onPrefix({cuts,ellipsisIdentity:shortLast===undefined ? "not-present" : fullCut && shortCut ? "ambiguous" : shortCut ? "generated" : "ambiguous"});
      }
    }
  }
  const piLines=pi.split("\n"), museLines=muse.split("\n");
  if(piLines.length!==museLines.length)throw invalid(0,0);
  let piBase=0,museBase=0;
  for(let i=0;i<piLines.length;i++) {
    if(onPrefix || piLines[i]!==museLines[i])line(piLines[i],museLines[i],piBase,museBase);
    piBase+=piLines[i].length+1;museBase+=museLines[i].length+1;
  }
  if(!spans.length && !onPrefix)throw invalid(0,0);
  report?.(spans);
  return {content:[{type:"text",text:pi}],isError:observed.isError};
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
