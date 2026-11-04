import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {assertToolResultVerifiable,toolResultReceipt} from '../src/tool-result-receipt.js';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'));
const text=fixture('multipart-text.json'),image=fixture('multipart-image.json');
const wire=fixture('multipart-wire.json');
const redacted=fixture('redacted-read.json');
const verify=(capture:any,mutation:any={},report=(images:any)=>{})=>toolResultReceipt({...capture.item,...mutation},capture.sent,undefined,undefined,report);

describe('Muse 1.4.14 multipart projection on synthetic fixtures (no inference)',()=>{
 it('binds the wire answer to the text_image scenario, exact call and turn',()=>{
  const start=wire.frames.find((r:any)=>r.dir==='out'&&r.msg.method==='turn/start').msg.params;
  const tool=wire.frames.find((r:any)=>r.msg?.params?.item?.kind==='toolCall').msg.params.item;
  const answer=wire.frames.find((r:any)=>r.msg?.params?.item?.kind==='agentMessage').msg.params.item;
  expect(start.input[0].text).toContain('mcp__pi__multipart_probe_text_image');
  expect(tool).toEqual(image.item);expect(answer.turnId).toBe(tool.turnId);
  expect(answer.text).toBe('The probe reports completion.');
  expect(tool).not.toHaveProperty('modelVisibleContent');
 });
 it('accepts the unmodified synthetic two-text result with its one-LF boundary',()=>{
  expect(verify(text)).toEqual(text.sent);
  expect(text.item.visibleOutput).toBe('ALPHA_PART_α\nEND_ONE\nBEGIN_TWO\nPART_TWO_終');
 });
 it.each(['','\n\n',' '])('rejects separator mutation %j',separator=>{
  expect(()=>verify(text,{visibleOutput:text.sent.content.map((p:any)=>p.text).join(separator)})).toThrow(/projection mismatch/);
 });
 it('preserves arbitrary nonempty text lists, embedded newlines and whitespace by the LF join rule',()=>{
  const sent={content:[{type:'text' as const,text:' first\n'},{type:'text' as const,text:'\nsecond '},{type:'text' as const,text:'終'}],isError:false};
  expect(toolResultReceipt({status:'completed',visibleOutput:' first\n\n\nsecond \n終'},sent)).toEqual(sent);
 });
 it('rejects reordering, dropping or changing a nonredacted text part',()=>{
  for(const visibleOutput of ['BEGIN_TWO\nPART_TWO_終\nALPHA_PART_α\nEND_ONE','ALPHA_PART_α\nEND_ONE',text.item.visibleOutput+'x'])
   expect(()=>verify(text,{visibleOutput})).toThrow(/projection mismatch/);
 });
 it('accepts the image placeholder without claiming its pixels/bytes were verified',()=>{
  const reports:any[]=[];expect(verify(image,{},images=>reports.push(...images))).toEqual(image.sent);
  const bytes=Buffer.from(image.sent.content[1].data,'base64');
  const imageBytes=Buffer.from(image.sent.content[1].data,'base64').length;
  expect(reports).toEqual([{partIndex:1,mimeType:'image/png',byteLen:imageBytes,sha256:createHash('sha256').update(bytes).digest('hex')}]);
  expect(JSON.stringify(reports)).not.toContain(image.sent.content[1].data);
  expect(()=>toolResultReceipt(image.item,image.sent)).toThrow(/declared-unverifiable reporting/);
 });
 it('checks decoded length against Pi bytes, not just a fixed captured count',()=>{
  const changed=structuredClone(image),bytes=Buffer.concat([Buffer.from(changed.sent.content[1].data,'base64'),Buffer.from([0])]);
  changed.sent.content[1].data=bytes.toString('base64');
  expect(()=>verify(changed)).toThrow(/placeholder differs/);
  const declaredBytes=Buffer.from(image.sent.content[1].data,'base64').length;
  expect(verify(changed,{visibleOutput:image.item.visibleOutput.replace(String(declaredBytes),String(declaredBytes+1))})).toEqual(changed.sent);
 });
 it('exposes same-size image-content changes as unverifiable, not false byte equality',()=>{
  const changed=structuredClone(image),bytes=Buffer.from(changed.sent.content[1].data,'base64');bytes[bytes.length-1]^=1;
  changed.sent.content[1].data=bytes.toString('base64');const reports:any[]=[];
  expect(verify(changed,{},images=>reports.push(...images))).toEqual(changed.sent);
  expect(reports[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
 });
 it.each([
  {visibleOutput:image.item.visibleOutput.replace(/bytes=\d+/,'bytes=850')},
  {visibleOutput:image.item.visibleOutput.replace('image/png','image/jpeg')},
  {visibleOutput:image.item.visibleOutput.replace(/bytes=\d+/,'bytes=[REDACTED]')},
  {visibleOutput:image.item.visibleOutput+'\n'},
  {modelVisibleContent:[{type:'image'}]},
  {status:'failed'},{failureKind:'unknown'},{failureReason:'bad'},{truncated:true},
 ])('refuses changed image projection/status %j without declaring delivery',mutation=>{
  const reports:any[]=[];expect(()=>verify(image,mutation,images=>reports.push(...images))).toThrow();expect(reports).toEqual([]);
 });
 it('uses full outputRef readback before comparing multipart/image output',()=>{
  for(const capture of [text,image]){
   expect(toolResultReceipt({...capture.item,visibleOutput:capture.item.visibleOutput.slice(0,5),truncated:true},capture.sent,capture.item.visibleOutput,undefined,()=>{})).toEqual(capture.sent);
   expect(()=>toolResultReceipt({...capture.item,visibleOutput:'wrong',truncated:true},capture.sent,capture.item.visibleOutput,undefined,()=>{})).toThrow(/differs/);
  }
 });
 it('keeps existing redactions inside text parts, including multipart and image text',()=>{
  for(const withImage of [false,true]){
   const sent={content:[{type:'text',text:redacted.sent.content[0].text},withImage?image.sent.content[1]:{type:'text',text:'SECOND_EXACT'}],isError:false};
   const imageBytes=Buffer.from(image.sent.content[1].data,'base64').length;
   const suffix=withImage?`[MCP image content: media_type=image/png, bytes=${imageBytes}]`:'SECOND_EXACT';
   const spans:any[]=[];expect(toolResultReceipt({status:'completed',visibleOutput:redacted.item.visibleOutput+'\n'+suffix},sent as any,undefined,r=>spans.push(...r),()=>{})).toEqual(sent);
   expect(spans).toHaveLength(3);
  }
 });
 it('never uses a part boundary as context for an otherwise unbounded redaction',()=>{
  const sent={content:[{type:'text' as const,text:'left secret'},{type:'text' as const,text:'right'}],isError:false};
  expect(()=>toolResultReceipt({status:'completed',visibleOutput:'left [REDACTED]\nright'},sent)).toThrow(/redaction/);
 });
 it.each([
  [],[image.sent.content[1]],
  [{type:'text',text:''},image.sent.content[1]],
  [{type:'text',text:''},{type:'text',text:'second'}],
  [image.sent.content[1],{type:'text',text:'after'}],
  [image.sent.content[0],image.sent.content[1],image.sent.content[1]],
  [image.sent.content[0],image.sent.content[1],{type:'text',text:'hints'}],
  [image.sent.content[0],{...image.sent.content[1],mimeType:'image/jpeg'}],
  [image.sent.content[0],{...image.sent.content[1],data:image.sent.content[1].data+'\n'}],
  [image.sent.content[0],{type:'image',mimeType:'image/png',data:'YWJj'}],
 ].map(content=>({content})))('refuses unqualified/invalid layouts before delivery $content',({content})=>{
  expect(()=>assertToolResultVerifiable({content} as any)).toThrow(/cannot verify MCP parts/);
 });
 it('keeps single-text empty output compatibility but refuses multipart errors',()=>{
  expect(toolResultReceipt({status:'completed',visibleOutput:''},{content:[{type:'text',text:''}],isError:false})).toEqual({content:[{type:'text',text:''}],isError:false});
  for(const capture of [text,image])expect(()=>toolResultReceipt(capture.item,{...capture.sent,isError:true},undefined,undefined,()=>{})).toThrow(/cannot verify MCP parts/);
 });
});
