import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {toolResultReceipt} from '../src/tool-result-receipt.js';
function receipt(text:string,visibleOutput:string){
 const spans:any[]=[];
 const sent:any={content:[{type:'text',text}],isError:false};
 const result=toolResultReceipt({status:'completed',visibleOutput},sent,undefined,s=>spans.push(...s));
 expect(result).toEqual(sent);return spans;
}
it('accounts for the actual official-client bearer codec that killed the plan read',()=>{
 const pi='A reference is an address, NOT a bearer permission. It is reverified.';
 const muse='A reference is an address, NOT a Bearer [REDACTED] It is reverified.';
 const spans=receipt(pi,muse);
 expect(spans).toHaveLength(2);
 expect(spans[0]).toMatchObject({piOffsetBytes:40,piByteLen:11,reason:'vendor-redaction',alignment:'unique',sources:[{partIndex:0,partOffsetBytes:40,byteLen:11}]});
 expect(spans[0].sha256).toBe(createHash('sha256').update('permission.').digest('hex'));
 expect(spans[1]).toMatchObject({piOffsetBytes:33,piByteLen:7,reason:'vendor-bearer-prefix'});
});
it('retains every viable boundary and marks ambiguous loss rather than choosing an exact parse',()=>{
 const spans=receipt('left x right y right z end','left [REDACTED] right [REDACTED] end');
 expect(spans).toHaveLength(2);
 expect(spans[0]).toMatchObject({reason:'ambiguous-vendor-redaction',alignment:'ambiguous',ambiguityReason:'multiple-alignments',candidateStartBytes:[5],candidateEndBytes:[6,14],piOffsetBytes:5,piByteLen:9});
 expect(spans[1]).toMatchObject({candidateStartBytes:[13,21],candidateEndBytes:[22],piOffsetBytes:13,piByteLen:9});
});
it('does not claim literal marker identity when a declared region swallowed source markers',()=>{
 const spans=receipt('aSECRET[REDACTED]z','a[REDACTED][REDACTED]z');
 expect(spans[0]).toMatchObject({alignment:'ambiguous',ambiguityReason:'literal-marker-identity',piOffsetBytes:1,piByteLen:16,candidateStartBytes:[1],candidateEndBytes:[17]});
});
it('maps UTF-8 loss into the actual original text part, not character offsets',()=>{
 const spans:any[]=[];
 toolResultReceipt({status:'completed',visibleOutput:'α\nβ [REDACTED] end'},{content:[{type:'text',text:'α'},{type:'text',text:'β secret end'}]},undefined,s=>spans.push(...s));
 expect(spans[0]).toMatchObject({piOffsetBytes:6,piByteLen:6,museOffsetBytes:6,sources:[{partIndex:1,partOffsetBytes:3,byteLen:6}]});
});
it.each([
 ['unrelated bearer exact; bearer secret end','unrelated Bearer exact; Bearer [REDACTED] end'],
 ['left bearer secret end','changed Bearer [REDACTED] end'],
 ['left bearer secret end','left BEARER [REDACTED] end'],
 ['left x right y right z end','left [REDACTED] WRONG [REDACTED] end'],
 ['left secret\rvalue end','left [REDACTED] end'],
])('fences genuine outside-loss corruption: %s',(pi,muse)=>{
 expect(()=>receipt(pi,muse)).toThrow(/mismatch.*byte/);
});
it('still fences status and image metadata independently of declared loss',()=>{
 expect(()=>toolResultReceipt({status:'failed',visibleOutput:'Bearer [REDACTED]'}, {content:[{type:'text',text:'bearer secret'}]})).toThrow(/status/);
 const png={type:'image' as const,mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
 expect(()=>toolResultReceipt({status:'completed',visibleOutput:'Bearer [REDACTED]\n[MCP image content: media_type=image/png, bytes=9]'},{content:[{type:'text',text:'bearer secret'},png]},undefined,()=>{},()=>{})).toThrow(/mismatch/);
});
