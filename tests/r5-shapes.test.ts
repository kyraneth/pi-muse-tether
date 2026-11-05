import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {assertToolResultVerifiable,toolResultReceipt} from '../src/tool-result-receipt.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/multipart-image.json',import.meta.url),'utf8'));
const png=fixture.sent.content[1];
const text=(value:string)=>({type:'text',text:value});
// Signature-only fixtures qualify transport checks, NOT image decoding. Live
// real-image fixtures and their pixel answers are retained separately in r5-work.
const image=(mimeType:string,bytes:Buffer)=>({type:'image',mimeType,data:bytes.toString('base64')});
const jpeg=image('image/jpeg',Buffer.from([255,216,255,224]));
const gif=image('image/gif',Buffer.from('GIF89a'));
const webp=image('image/webp',Buffer.from('RIFF0000WEBP'));
const placeholder=(p:any)=>`[MCP image content: media_type=${p.mimeType}, bytes=${Buffer.from(p.data,'base64').length}]`;
const shapes=[
 {name:'PNG',content:[text('before'),png],wire:'before\n'+placeholder(png)},
 {name:'JPEG',content:[text('before'),jpeg],wire:'before\n'+placeholder(jpeg)},
 {name:'GIF',content:[gif],wire:placeholder(gif)},
 {name:'WebP',content:[webp],wire:placeholder(webp)},
 {name:'image-only',content:[png],wire:placeholder(png)},
 {name:'several images',content:[png,jpeg,gif,webp],wire:[png,jpeg,gif,webp].map(placeholder).join('\n')},
 {name:'empty text',content:[text(''),text('after'),text('')],wire:'after\n'},
 {name:'empty image edges',content:[text(''),png,text('')],wire:placeholder(png)+'\n'},
 {name:'interleaved',content:[text('before'),png,text('after'),jpeg,text('end')],wire:'before\n'+placeholder(png)+'\nafter\n'+placeholder(jpeg)+'\nend'},
 {name:'leading newline',content:[text('\nreal LF'),png],wire:'\nreal LF\n'+placeholder(png)},
 {name:'literal placeholder',content:[text(placeholder(png)),png],wire:placeholder(png)+'\n'+placeholder(png)},
 {name:'empty content',content:[],wire:'[MCP tool returned no content]'},
];
describe('r5 positional shape conformance and seeded mismatches',()=>{
 for(const shape of shapes) {
  it(shape.name,()=>{
   const sent:any={content:shape.content,isError:false},images:any[]=[];
   assertToolResultVerifiable(sent);
   expect(toolResultReceipt({status:'completed',visibleOutput:shape.wire},sent,undefined,undefined,r=>images.push(...r))).toEqual(sent);
   expect(images).toHaveLength(shape.content.filter(p=>p.type==='image').length);
   // Seed a change outside every accepted loss region. It must still fail.
   expect(()=>toolResultReceipt({status:'completed',visibleOutput:shape.wire+'!'},sent,undefined,undefined,()=>{})).toThrow(/projection mismatch/);
  });
 }
 it('error results with multiple images preserve failed status and text exactly',()=>{
  const sent:any={content:[text('error details'),png,jpeg],isError:true};
  const reason='error details';
  expect(toolResultReceipt({status:'failed',failureReason:reason,visibleOutput:'tool failed: '+reason},sent,undefined,undefined,()=>{})).toEqual(sent);
  expect(()=>toolResultReceipt({status:'failed',failureReason:reason+'!',visibleOutput:'tool failed: '+reason+'!'},sent,undefined,undefined,()=>{})).toThrow();
 });
 it('declares omitted error-only images and checks the native empty-error fallback',()=>{
  const sent:any={content:[png],isError:true},images:any[]=[];
  const item={status:'failed',failureReason:'MCP tool returned an error',visibleOutput:'tool failed: MCP tool returned an error'};
  expect(toolResultReceipt(item,sent,undefined,undefined,r=>images.push(...r))).toEqual(sent);
  expect(images[0].modelVisibility).toBe('omitted-error-result');
  expect(()=>toolResultReceipt({...item,failureReason:'changed',visibleOutput:'tool failed: changed'},sent,undefined,undefined,()=>{})).toThrow();
 });
 it('uses the distinct native error text join including leading empty parts',()=>{
  const sent:any={content:[text(''),text('first'),text(''),text('second'),png,text('')],isError:true};
  const reason='\nfirst\n\nsecond\n';
  expect(toolResultReceipt({status:'failed',failureReason:reason,visibleOutput:'tool failed: '+reason},sent,undefined,undefined,()=>{})).toEqual(sent);
  expect(()=>toolResultReceipt({status:'failed',failureReason:reason.slice(1),visibleOutput:'tool failed: '+reason.slice(1)},sent,undefined,undefined,()=>{})).toThrow(/projection mismatch/);
 });
 it('accepts derivative evidence without claiming original pixel equality',()=>{
  const images:any[]=[];
  expect(toolResultReceipt({...fixture.item,modelVisibleContent:[{type:'image',mimeType:'image/jpeg',data:jpeg.data}]},fixture.sent,undefined,undefined,r=>images.push(...r))).toEqual(fixture.sent);
  expect(images[0].mimeType).toBe('image/png');
 });
 it('truncated image output needs full readback and exact prefix',()=>{
  const shape=shapes[7],sent:any={content:shape.content,isError:false};
  expect(toolResultReceipt({status:'completed',truncated:true,visibleOutput:shape.wire.slice(0,6)},sent,shape.wire,undefined,()=>{})).toEqual(sent);
  expect(()=>toolResultReceipt({status:'completed',truncated:true,visibleOutput:'wrong'},sent,shape.wire,undefined,()=>{})).toThrow(/differs/);
 });
 it('never permits a redaction hole to hide image metadata',()=>{
  expect(()=>toolResultReceipt({status:'completed',visibleOutput:'before\n[REDACTED]'},{content:[text('before'),png]} as any,undefined,()=>{},()=>{})).toThrow(/image.*differs/);
 });
});
