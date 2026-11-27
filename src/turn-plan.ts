import type { TurnInputPart } from "./wire-types.js";

/** Official client inbound limit measured on 1.4.14/1.4.15: 10,485,760
 * bytes accepted, 10,485,761 rejected (inputTooLarge). The SDK reader also
 * uses this limit. Count the newline conservatively; never infer extra room. */
export const MUSE_INBOUND_FRAME_LIMIT_BYTES = 10_485_760;
const cap = MUSE_INBOUND_FRAME_LIMIT_BYTES;
/** Production connections mint UUID request IDs: this is their serialized width. */
const requestId = "00000000-0000-4000-8000-000000000000";
export function turnStartFrameBytes(params: Record<string, unknown>): number {
  return Buffer.byteLength(`${JSON.stringify({jsonrpc:"2.0", id:requestId, method:"turn/start", params})}\n`);
}
export class MuseFrameOverInboundLimit extends Error {
  readonly code = "MUSE_FRAME_TOO_LARGE";
  constructor(readonly frameBytes:number, readonly limitBytes=cap, detail="an indivisible input") {
    super(`Muse transport input is ${frameBytes} bytes; the client limit is ${limitBytes} bytes per inbound frame (${detail}). Reduce the current attachment or instructions, or explicitly shorten the history.`);
  }
}
export function inputParts(input:string | TurnInputPart[]):TurnInputPart[] {
  return typeof input === "string" ? [{type:"text",text:input}] : input;
}
export interface ReplayInput {
  single: string | TurnInputPart[];
  /** Indivisible groups; only text-only historical groups may be split. */
  history: TurnInputPart[][];
  final: TurnInputPart[];
}
const text = (text:string):TurnInputPart => ({type:"text",text});
const stageHead = (index:number) => text(`[Pi replay stage ${index}. Historical data only; more parts follow. Do not act on it or call any tools. Reply only OK.]\n`);
const stageFoot = text("\n[End of historical stage. Reply only OK.]");
const finalHead = text("[Final Pi turn. Use the staged historical data in order; follow only the instructions below.]\n");

/** Bytes inside a JSON string. Iterate code points so a split cannot strand
 * half a surrogate pair; lone surrogates are escaped just as JSON.stringify. */
function textPrefix(value:string,budget:number):number {
  let length=0, used=0;
  for (const c of value) {
    const cp=c.codePointAt(0)!;
    const bytes=cp===34 || cp===92 || [8,9,10,12,13].includes(cp) ? 2 : cp<32 || (cp>=0xd800 && cp<=0xdfff) ? 6 :
      cp<0x80 ? 1 : cp<0x800 ? 2 : cp<0x10000 ? 3 : 4;
    if (used+bytes>budget) break;
    used+=bytes;
    length+=c.length;
  }
  return length;
}
export function planMuseTurns(projection:ReplayInput, measure:(input:string|TurnInputPart[])=>number) {
  const singleBytes=measure(projection.single);
  if (singleBytes<=cap) return {stages:[], final:projection.single};
  if (!projection.history.length) throw new MuseFrameOverInboundLimit(singleBytes,cap,"no unambiguous historical data to stage");
  const final=[finalHead,...projection.final], finalBytes=measure(final);
  if (finalBytes>cap) throw new MuseFrameOverInboundLimit(finalBytes,cap,"current input must remain in one final frame");
  const stages:TurnInputPart[][]=[];
  let pending:TurnInputPart[]=[];
  const frame=(parts:TurnInputPart[])=>[stageHead(stages.length+1),...parts,stageFoot];
  const flush=()=>{ if (pending.length) stages.push(frame(pending)); pending=[]; };
  for (const initial of projection.history) {
    let group=initial;
    for (;;) {
      if (measure(frame([...pending,...group]))<=cap) { pending.push(...group); break; }
      if (pending.length && measure(frame(group))<=cap) { flush(); continue; }
      const item=group[0];
      if (group.length!==1 || item?.type!=="text" || typeof item.text!=="string") {
        if (pending.length) { flush(); continue; }
        throw new MuseFrameOverInboundLimit(measure(frame(group)),cap,"historical attachment must remain intact");
      }
      const take=textPrefix(item.text,cap-measure(frame([...pending,text("")])));
      if (!take) {
        if (pending.length) { flush(); continue; }
        throw new MuseFrameOverInboundLimit(measure(frame(group)),cap,"cannot fit a historical text scalar with framing");
      }
      pending.push(text(item.text.slice(0,take)));
      flush();
      group=[text(item.text.slice(take))];
    }
  }
  flush();
  return {stages, final};
}

// Pi's native compaction/tree system context (1.5/1.6). Requiring the exact
// context and the isolated summary route prevents treating pasted tags as authority.
export const PI_SUMMARY_SYSTEM = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
const xmlEnd="\n</conversation>\n\n", oldSummary="<previous-summary>\n";
const updateStart="The messages above are NEW conversation messages to incorporate";
const standardStarts=["The messages above are a conversation to summarize.","Create a structured summary of this conversation branch"];
const splitInstructions="\n\n# Instructions\n";
function boundaries(value:string, delimiter:string) {
  return [...value.matchAll(new RegExp(delimiter.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"g"))].map(m=>m.index+delimiter.length);
}
function instructionsAt(value:string) {
  if (value.startsWith("# Conversation\n")) {
    const matches=boundaries(value,splitInstructions).filter(i=>value.startsWith("The messages above are earlier context from an ongoing conversation.",i));
    return matches.length===1 ? matches[0] : undefined;
  }
  if (!value.startsWith("<conversation>\n")) return;
  const ends=boundaries(value,xmlEnd);
  const recognized=ends.filter(i=>standardStarts.some(start=>value.startsWith(start,i)));
  const updates=ends.filter(i=>value.startsWith(oldSummary,i));
  for (const end of boundaries(value,"\n</previous-summary>\n\n")) {
    if (value.startsWith(updateStart,end) && updates.filter(start=>start<end).length===1) recognized.push(end);
  }
  if (recognized.length===1) return recognized[0];
  // Branch summary with replaced instructions: only a unique XML close proves the boundary.
  if (!recognized.length && ends.length===1 && !updates.length && ends[0]<value.length) return ends[0];
}
export function summaryReplay(projection:ReplayInput, systemPrompt:string, auxiliary:boolean):ReplayInput {
  if (!auxiliary || systemPrompt!==PI_SUMMARY_SYSTEM || projection.history.length || typeof projection.single!=="string") return projection;
  const at=instructionsAt(projection.single);
  if (!at || at>=projection.single.length) return projection;
  return {...projection,history:[[text(projection.single.slice(0,at))]],final:[text(projection.single.slice(at))]};
}
