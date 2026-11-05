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
