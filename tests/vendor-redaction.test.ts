import {it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {toolResultReceipt} from "../src/tool-result-receipt.js";
import {publishRedactionStatus,publishRetryStatus,setRetryStatusListener} from "../src/retry-status.js";
const real=JSON.parse(readFileSync(new URL("./fixtures/redacted-read.json",import.meta.url),"utf8"));
const spanStarts=[real.sent.content[0].text.indexOf("sk-"),real.sent.content[0].text.indexOf("sk-A"),real.sent.content[0].text.indexOf("sk-SECRET12")];
const firstSpan=spanStarts[0];
const pi=real.sent.content[0].text;
const check=(text:string,item=real.item)=>toolResultReceipt(item,{content:[{type:"text",text}],isError:false});
it("qualifies the synthetic redacted read with declared redaction, preserving literal Pi markers",()=>{
 const records:any[]=[];
 expect(toolResultReceipt(real.item,real.sent,undefined,s=>records.push(...s))).toEqual(real.sent);
 expect(records).toHaveLength(3);
 expect(records[0].piOffsetBytes).toBe(Buffer.byteLength(pi.slice(0,firstSpan)));
 expect(records.map(s=>s.piByteLen)).toEqual([3,4,11]);
 expect(records[0].sha256).toBe(createHash("sha256").update("sk-").digest("hex"));
 expect(JSON.stringify(records)).not.toContain("sk-");
});
it.each([0,Math.floor(pi.length/2),pi.length-1,firstSpan-1,firstSpan+4,spanStarts[1]-1])("rejects a one-char mutation outside a redaction at %i",offset=>{
 const text=pi.slice(0,offset)+(pi[offset]==="x"?"y":"x")+pi.slice(offset+1);
 expect(()=>check(text)).toThrow(/redaction/);
});
it.each([
 ["left  right","left [REDACTED] right"],
 ["left multi\nline right","left [REDACTED] right"],
 ["left [REDACTED] right","left [REDACTED][REDACTED] right"],
 ["left x right y right z end","left [REDACTED] right [REDACTED] end"],
])("rejects nonqualifying/ambiguous marker %j -> %j",(text,visibleOutput)=>{
 expect(()=>check(text,{status:"completed",visibleOutput})).toThrow(/redaction/);
});
it.each([
 ["gone right","[REDACTED] right"],
 ["left gone","left [REDACTED]"],
 ["password: synthetic-value\n","password: [REDACTED]\n"],
 ["before\nsynthetic right","before\n[REDACTED] right"],
 ["whole synthetic line","[REDACTED]"],
 ["left synthetic-one synthetic-two right","left [REDACTED][REDACTED] right"],
])("accepts declared-lossy unique line-edge redaction %j -> %j",(text,visibleOutput)=>{
 const spans:any[]=[];
 expect(toolResultReceipt({status:"completed",visibleOutput},{content:[{type:"text",text}],isError:false},undefined,s=>spans.push(...s))).toEqual({content:[{type:"text",text}],isError:false});
 expect(spans).toHaveLength(1);
});
it.each([
 ["aSECRET[REDACTED]z","a[REDACTED][REDACTED]z",1,6],
 ["a[REDACTED]SECRETz","a[REDACTED][REDACTED]z",11,6],
 ["aXz","a[REDACTED][REDACTED]z",1,1],
])("keeps literal markers exact beside adjacent declared loss %j",(text,visibleOutput,offset,length)=>{
 const spans:any[]=[];
 expect(toolResultReceipt({status:"completed",visibleOutput},{content:[{type:"text",text}],isError:false},undefined,s=>spans.push(...s))).toEqual({content:[{type:"text",text}],isError:false});
 expect(spans).toHaveLength(1);expect(spans[0].piOffsetBytes).toBe(offset);expect(spans[0].piByteLen).toBe(length);
});
it("accepts longer uniquely aligned spans without suffix rescanning",()=>{
 const text="left x right x right";
 expect(check(text,{status:"completed",visibleOutput:"left [REDACTED] right"}).content[0]).toEqual({type:"text",text});
});
it("keeps an unchanged literal marker exact, never interpreting it as a redaction",()=>{
 const sent={content:[{type:"text" as const,text:"a [REDACTED] b"}],isError:false};const report:any[]=[];
 expect(toolResultReceipt({status:"completed",visibleOutput:sent.content[0].text},sent,undefined,s=>report.push(s))).toEqual(sent);
 expect(report).toEqual([]);
});
it("reports vendor loss through supported status only and clears per owner",()=>{
 const owner={},other={},statuses:any[]=[];setRetryStatusListener(s=>statuses.push(s));
 try{publishRedactionStatus(owner,3);publishRetryStatus(other);expect(statuses.at(-1)).toContain("redacted 3");publishRetryStatus(owner);expect(statuses.at(-1)).toBeUndefined();}
 finally{publishRetryStatus(owner);setRetryStatusListener(undefined);}
});
