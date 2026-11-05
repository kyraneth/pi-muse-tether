import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {toolResultReceipt,assertToolResultVerifiable,readStoredToolOutput} from '../src/tool-result-receipt.js';
// Copied from pi-tether-core 6bcd8f9 conformance/tool-results.json; the Unicode
// case uses a neutral Arabic greeting instead of an identifying proper name.
// Same 48 cases/obligations, no dependency bump. Native projections stay local.
const corpus=JSON.parse(readFileSync(new URL('./fixtures/shared-tool-results.json',import.meta.url),'utf8'));
function wire(content:any[]) {
 let value='';
 for(const p of content) {
  if(p.type==='text') value+=(value?'\n':'')+p.text;
  else value+=(value?'\n':'')+`[MCP image content: media_type=${p.mimeType}, bytes=${Buffer.from(p.data,'base64').length}]`;
 }
 return value||'[MCP tool returned no content]';
}
for(const c of corpus.cases)it(`shared ${c.id}: ${c.acceptance}`,async()=>{
 if(c.tags.includes('malformed')) {expect(()=>assertToolResultVerifiable(c.result)).toThrow();return;}
 let visible=wire(c.result.isError===true?c.result.content.filter((p:any)=>p.type==='text'):c.result.content);
 if(c.observed && !c.tags.includes('image'))visible=wire(c.observed.content);
 const error=(c.observed?.isError ?? c.result.isError)===true;
 if(error && c.result.content.every((p:any)=>p.type!=='text'||!p.text))visible='MCP tool returned an error';
 const item:any=error?{status:'failed',failureReason:visible,visibleOutput:'tool failed: '+visible}:{status:'completed',visibleOutput:visible};
 if(c.id==='derivative-image')item.modelVisibleContent=c.observed.content;
 const redactions:any[]=[],images:any[]=[];
 let stored:string|undefined;
 if(c.tags.includes('paging')) {
  const body=visible,byteLen=Buffer.byteLength(body);
  stored=await readStoredToolOutput({outputRef:{id:'fixture',availability:'available',byteLen}},async(offsetBytes)=>({offsetBytes,byteLen,content:body,encoding:'utf8',mediaType:'text/plain',eof:true}));
  item.truncated=true;item.visibleOutput=body.slice(0,body.indexOf('\n')+1);
 }
 const verify=()=>toolResultReceipt(item,c.result,stored,r=>redactions.push(...r),r=>images.push(...r));
 if(c.acceptance==='reject') {expect(verify).toThrow();return;}
 expect(verify()).toEqual(c.result);
 expect(images).toHaveLength(c.result.content.filter((p:any)=>p.type==='image').length);
 if(c.tags.includes('redaction'))expect(redactions.length).toBeGreaterThan(0);
 // Seed an unaffected-text corruption for EVERY accepted corpus shape.
 expect(()=>toolResultReceipt({...item,visibleOutput:item.visibleOutput+'!',...(error?{failureReason:item.failureReason+'!'}:{})},c.result,undefined,()=>{},()=>{})).toThrow();
});
