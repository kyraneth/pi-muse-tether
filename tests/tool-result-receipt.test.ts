import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {toolResultReceipt,readStoredToolOutput} from "../src/tool-result-receipt.js";
const real=JSON.parse(readFileSync(new URL("./fixtures/tool-errors.json",import.meta.url),"utf8"));
const errorItem=real.frames[0].frame.params.item;
const sent={content:real.piErrors[0].content,isError:true};
const success={status:"completed",visibleOutput:"abc"};
const ok={content:[{type:"text" as const,text:"abc"}],isError:false};
const ref={id:"ref",availability:"available",byteLen:3,mediaType:"text/plain"};
const page={offsetBytes:0,byteLen:3,content:"abc",encoding:"utf8",eof:true,mediaType:"text/plain"};
describe("MSP 1.4.14 exact tool result receipts",()=>{
 it("verifies the unmodified fixture ENOENT frame against the journal result",()=>{
  expect(toolResultReceipt(errorItem,sent)).toEqual(sent);
  expect(errorItem.visibleOutput).toBe(`tool failed: ${sent.content[0].text}`);
 });
 it.each(real.frames.slice(1))("refuses fixture cancellation/approval-abort frame $line as consumption of an error",({frame}:any)=>{
  expect(()=>toolResultReceipt(frame.params.item,sent)).toThrow();
 });
 it.each([
  {status:"completed"},{status:"rejected"},{failureKind:"approval_denied"},
  {failureReason:"changed"},{visibleOutput:"changed"},{visibleOutput:undefined},
  {truncated:true},
 ])("rejects mutated error receipt %j",mutation=>{
  expect(()=>toolResultReceipt({...errorItem,...mutation},sent)).toThrow();
 });
 it("fails hard on changed failureReason even when matching its display",()=>{
  expect(()=>toolResultReceipt({...errorItem,failureReason:"changed",visibleOutput:"tool failed: changed"},sent)).toThrow(/projection mismatch/);
 });
 it.each([{status:"failed"},{failureKind:"failed"},{failureReason:"error"}])("rejects successful-result status/error mutation %j",mutation=>{
  expect(()=>toolResultReceipt({...success,...mutation},ok)).toThrow();
 });
 it.each([
  {content:[{type:"text",text:""},{type:"text",text:"bc"}],isError:false},
  {content:[{type:"image",mimeType:"image/png",data:"YWJj"}],isError:false},
  {content:[{type:"text",text:"abc"},{type:"image",mimeType:"image/png",data:"YWJj"}],isError:false},
  {content:[],isError:false},
 ])("fails loudly when MSP cannot prove MCP parts %j",result=>{
  expect(()=>toolResultReceipt(success,result as any)).toThrow(/projection mismatch|malformed image/);
 });
 it("accepts exact text with outputRef, with and without a truncated view",async()=>{
  const stored=await readStoredToolOutput({outputRef:ref},async()=>page);
  expect(toolResultReceipt({...success,outputRef:ref},ok,stored)).toEqual(ok);
  expect(toolResultReceipt({...success,outputRef:ref,truncated:true,visibleOutput:"a"},ok,stored)).toEqual(ok);
  expect(()=>toolResultReceipt({...success,visibleOutput:"x",truncated:true},ok,stored)).toThrow(/differs/);
  expect(()=>toolResultReceipt({...success,visibleOutput:"a"},ok,stored)).toThrow(/differs/);
 });
 it("verifies the captured ellipsis codec against a stored body without weakening strict readback",async()=>{
  const body="α🙂tail",bytes=Buffer.from(body),digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const stored=await readStoredToolOutput({outputRef:{...ref,byteLen:bytes.length,digest}},async()=>({...page,content:body,byteLen:bytes.length}));
  const result={content:[{type:"text" as const,text:body}],isError:false};
  expect(toolResultReceipt({status:"completed",truncated:true,visibleOutput:"α🙂…"},result,stored)).toBe(result);
  expect(()=>toolResultReceipt({status:"completed",truncated:true,visibleOutput:"αx…"},result,stored)).toThrow(/differs/);
  await expect(readStoredToolOutput({outputRef:{...ref,byteLen:bytes.length,digest:"sha256:wrong"}},async()=>({...page,content:body,byteLen:bytes.length}))).rejects.toThrow(/digest/);
 });
 it.each([1,"true",0,"false",null,{},[]])("rejects malformed truncated flag %j with and without stored readback",truncated=>{
  const result={content:[{type:"text" as const,text:"prefix secret tail"}],isError:false};
  const item={status:"completed",visibleOutput:"prefix [REDACTED]",truncated};
  for(const stored of [undefined,"prefix [REDACTED]"]) {
   const redactions:any[]=[],views:any[]=[];
   expect(()=>toolResultReceipt(item,result,stored,s=>redactions.push(...s),undefined,v=>views.push(v))).toThrow(/truncated flag must be boolean/);
   expect(redactions).toEqual([]);expect(views).toEqual([]);
  }
 });
 it.each([undefined,{availability:"missing"},{availability:"unsupported"},{availability:"accessFailed"}])("declares a literal UTF-8 prefix with absent or known unavailable ref %j",outputRef=>{
  const result={content:[{type:"text" as const,text:"αbeta"},{type:"text" as const,text:"終 tail"}]};
  const reports:any[]=[];
  expect(toolResultReceipt({status:"completed",truncated:true,visibleOutput:"αb",...(outputRef?{outputRef}:{})},result,undefined,undefined,undefined,v=>reports.push(v))).toBe(result);
  expect(reports[0]).toMatchObject({visibleBytes:3,omittedOffsetBytes:3,sources:[{partIndex:0,partOffsetBytes:3,byteLen:3},{partIndex:1,partOffsetBytes:0,byteLen:8}]});
 });
 it.each([undefined,{availability:"missing"},{availability:"unsupported"},{availability:"accessFailed"}])("accepts the observed ellipsis after a verified UTF-8 prefix with unavailable ref %j",outputRef=>{
  const result={content:[{type:"text" as const,text:"α🙂suffix"}]},views:any[]=[];
  const item={status:"completed",truncated:true,visibleOutput:"α🙂…",...(outputRef?{outputRef}:{})};
  expect(toolResultReceipt(item,result,undefined,undefined,undefined,v=>views.push(v))).toBe(result);
  expect(views[0]).toMatchObject({visibleBytes:9,omittedOffsetBytes:6,ellipsisIdentity:"generated",candidateOmittedOffsetsBytes:[6],sources:[{partIndex:0,partOffsetBytes:6,byteLen:6}]});
 });
 it("declares ambiguous identity and covering suffix when a literal ellipsis also matches",()=>{
  const result={content:[{type:"text" as const,text:"α…tail"}]},views:any[]=[];
  expect(toolResultReceipt({status:"completed",truncated:true,visibleOutput:"α…"},result,undefined,undefined,undefined,v=>views.push(v))).toBe(result);
  expect(views[0]).toMatchObject({ellipsisIdentity:"ambiguous",candidateOmittedOffsetsBytes:[2,5],omittedOffsetBytes:2,omittedByteLen:7,sources:[{partIndex:0,partOffsetBytes:2,byteLen:7}]});
 });
 it("reconciles complete redacted lines then locates the truncated suffix in original multipart bytes",()=>{
  const first="α bearer permission. tail",second="left x right y right z end\n🙂literal…tail";
  const result={content:[{type:"text" as const,text:first},{type:"text" as const,text:second}]};
  const visible="α Bearer [REDACTED] tail\nleft [REDACTED] right [REDACTED] end\n🙂literal…";
  const spans:any[]=[],views:any[]=[];
  expect(toolResultReceipt({status:"completed",truncated:true,visibleOutput:visible},result,undefined,s=>spans.push(...s),undefined,v=>views.push(v))).toBe(result);
  expect(spans).toHaveLength(4);
  expect(spans.some(s=>s.reason==="vendor-bearer-prefix" && s.sources[0].partIndex===0)).toBe(true);
  expect(spans.filter(s=>s.alignment==="ambiguous")).toHaveLength(2);
  const partOffset=Buffer.byteLength("left x right y right z end\n🙂literal"),originalOffset=Buffer.byteLength(first+"\n")+partOffset;
  expect(views[0]).toMatchObject({visibleBytes:Buffer.byteLength(visible),ellipsisIdentity:"ambiguous",candidateOmittedOffsetsBytes:[originalOffset,originalOffset+3],omittedOffsetBytes:originalOffset,sources:[{partIndex:1,partOffsetBytes:partOffset,byteLen:7}]});
  expect(views[0].sha256).toBe(createHash("sha256").update("…tail").digest("hex"));
 });
 it("still fences redacted truncated views against an unredacted stored body",()=>{
  const text="prefix bearer permission. end\nplain tail",result={content:[{type:"text" as const,text}]};
  const item={status:"completed",truncated:true,visibleOutput:"prefix Bearer [REDACTED] end\nplain…"};
  const spans:any[]=[],views:any[]=[];
  expect(()=>toolResultReceipt(item,result,text,s=>spans.push(...s),undefined,v=>views.push(v))).toThrow(/stored tool output differs/);
  expect(spans).toEqual([]);expect(views).toEqual([]);
 });
 it("reconciles same-line bearer, literal marker, and repeated redactions before a UTF-8 cut",()=>{
  const a="α bearer permission. literal [REDACTED] ",b="token A token B exact 🙂tail";
  const result={content:[{type:"text" as const,text:a+b}]},spans:any[]=[],views:any[]=[];
  const visible="α Bearer [REDACTED] literal [REDACTED] token [REDACTED] token [REDACTED] exact 🙂…";
  expect(toolResultReceipt({status:"completed",truncated:true,visibleOutput:visible},result,undefined,s=>spans.push(...s),undefined,v=>views.push(v))).toBe(result);
  expect(spans.length).toBeGreaterThan(0);expect(spans.some(s=>s.reason==="vendor-bearer-prefix")).toBe(true);
  expect(spans.every(s=>s.sources.every((source:any)=>source.partIndex===0))).toBe(true);
  expect(views[0]).toMatchObject({omittedOffsetBytes:Buffer.byteLength(a+"token A token B exact 🙂"),ellipsisIdentity:"generated"});
  expect(views[0].sha256).toBe(createHash("sha256").update("tail").digest("hex"));
  for(const changed of [visible.replace("α Bearer","X Bearer"),visible.replace(" exact "," WRONG "),visible.replace("🙂…","🙃…")]) {
   const failures:any[]=[];expect(()=>toolResultReceipt({status:"completed",truncated:true,visibleOutput:changed},result,undefined,s=>failures.push(s),undefined,v=>failures.push(v))).toThrow();expect(failures).toEqual([]);
  }
 });
 it.each(["a[REDACTED]","a[REDACTED]…"])("retains every viable cut when a partial view equals a literal-marker source line: %s",visibleOutput=>{
  const text="a[REDACTED]\nnext line",result={content:[{type:"text" as const,text}]},spans:any[]=[],views:any[]=[];
  expect(toolResultReceipt({status:"completed",truncated:true,visibleOutput},result,undefined,s=>spans.push(...s),undefined,v=>views.push(v))).toBe(result);
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({alignment:"ambiguous",ambiguityReason:"multiple-alignments",piOffsetBytes:1,piByteLen:10,sources:[{partIndex:0,partOffsetBytes:1,byteLen:10}]});
  expect(views[0]).toMatchObject({omittedOffsetBytes:2,candidateOmittedOffsetsBytes:[2,3,4,5,6,7,8,9,10,11],ellipsisIdentity:visibleOutput.endsWith("…")?"generated":"not-present",sources:[{partIndex:0,partOffsetBytes:2,byteLen:Buffer.byteLength(text)-2}]});
  expect(views[0].sha256).toBe(createHash("sha256").update(text.slice(2)).digest("hex"));
  expect(()=>toolResultReceipt({status:"completed",truncated:true,visibleOutput},result,undefined,undefined,undefined,()=>{})).toThrow(/declared-redaction/);
 });
 it("keeps full-frame literal-marker identity exact",()=>{
  const text="a[REDACTED]\nnext line",result={content:[{type:"text" as const,text}]},spans:any[]=[];
  expect(toolResultReceipt({status:"completed",visibleOutput:text},result,undefined,s=>spans.push(...s))).toBe(result);
  expect(spans).toEqual([]);
 });
 it("never locates a redaction or cut inside a UTF-8 code point",()=>{
  const result={content:[{type:"text" as const,text:"α 🙂tail"}]},spans:any[]=[],views:any[]=[];
  toolResultReceipt({status:"completed",truncated:true,visibleOutput:"α [REDACTED]…"},result,undefined,s=>spans.push(...s),undefined,v=>views.push(v));
  expect(views[0].candidateOmittedOffsetsBytes).toEqual([7,8,9,10,11]);
  expect(spans[0].candidateEndBytes).toEqual([7,8,9,10,11]);
 });
 it("keeps all viable original cuts for same-line partial redaction",()=>{
  const result={content:[{type:"text" as const,text:"α A x B x tail"}]},spans:any[]=[],views:any[]=[];
  expect(toolResultReceipt({status:"completed",truncated:true,visibleOutput:"α [REDACTED]x…"},result,undefined,s=>spans.push(...s),undefined,v=>views.push(v))).toBe(result);
  expect(spans).toHaveLength(1);expect(spans[0]).toMatchObject({alignment:"ambiguous",sources:[{partIndex:0,partOffsetBytes:3}]});
  expect(views[0]).toMatchObject({ellipsisIdentity:"generated",candidateOmittedOffsetsBytes:[6,10],omittedOffsetBytes:6});
  expect(views[0].sha256).toBe(createHash("sha256").update(" B x tail").digest("hex"));
 });
 it("fences corrupt complete or partial lines without publishing loss",()=>{
  const result={content:[{type:"text" as const,text:"α bearer permission. tail\n🙂plain tail"}]};
  const valid="α Bearer [REDACTED] tail\n🙂plain…";
  for(const visibleOutput of [valid.replace("tail\n","FAIL\n"),valid.replace("🙂plain","🙂plXin"),"α Bearer [REDACTED] tail\n🙂[REDACTED]MISMATCH…"]) {
   const spans:any[]=[],views:any[]=[];
   expect(()=>toolResultReceipt({status:"completed",truncated:true,visibleOutput},result,undefined,s=>spans.push(...s),undefined,v=>views.push(v))).toThrow();
   expect(spans).toEqual([]);expect(views).toEqual([]);
  }
  expect(()=>toolResultReceipt({status:"completed",truncated:true,visibleOutput:valid},result,undefined,undefined,undefined,()=>{})).toThrow(/declared-redaction/);
 });
 it("does not invent redaction, broken Unicode, unknown refs or visible corruption in a truncated view",()=>{
  const result={content:[{type:"text" as const,text:"α secret 🙂 tail"}]};
  for(const item of [
   {visibleOutput:"α [REDACTED]WRONG…"},{visibleOutput:"wrong"},{visibleOutput:"α x…"},{visibleOutput:"α secret \ud83d"},
   {visibleOutput:"α",outputRef:{availability:"available"}},{visibleOutput:"α",outputRef:{availability:"future"}},
  ]) expect(()=>toolResultReceipt({status:"completed",truncated:true,...item},result,undefined,undefined,undefined,()=>{})).toThrow();
 });
 it("verifies UTF-8 bytes, optional digest and short pages by actual served length",async()=>{
  const body="é🙂終",bytes=Buffer.from(body),offsets:number[]=[];
  const digest=`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const parts=["é","🙂","終"];
  const stored=await readStoredToolOutput({outputRef:{...ref,byteLen:bytes.length,digest}},async offset=>{
   offsets.push(offset);const content=parts.shift()!;
   return {...page,content,offsetBytes:offset,byteLen:Buffer.byteLength(content),eof:parts.length===0};
  });
  expect(offsets).toEqual([0,2,6]);expect(stored).toBe(body);
 });
 it.each([
  {encoding:"base64"},{mediaType:"application/json"},{offsetBytes:1},{byteLen:2},
  {eof:false,byteLen:0,content:""},{eof:true,byteLen:2,content:"ab"},{content:"abcd",byteLen:4},
 ])("rejects readOutput page mutation %j",async mutation=>{
  await expect(readStoredToolOutput({outputRef:ref},async()=>({...page,...mutation}))).rejects.toThrow(/item\/readOutput/);
 });
 it.each([
  {availability:"missing"},{availability:"unsupported"},{availability:"accessFailed"},
  {byteLen:-1},{id:""},{mediaType:"image/png"},{digest:"sha256:wrong"},{digest:"md5:unsupported"},
 ])("rejects outputRef mutation %j",async mutation=>{
  await expect(readStoredToolOutput({outputRef:{...ref,...mutation}},async()=>page)).rejects.toThrow();
 });
});
