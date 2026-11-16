import { expect, it } from "vitest";
import { batchBoundarySchemaMatches, committedCalls, BATCH_SCHEMA_SOURCES } from "../src/batch-schema.js";
const frame=()=>({subscriptionId:1,record:{schema_version:1,payload_schema_version:1,causation_id:null,durability:"ephemeral",id:"record",payload_type:"run.event",record_type:"event",recorded_at:0,sequence:1,stream:{kind:"session.live",id:"session"},payload:{kind:"run",run_id:"turn",event:{kind:"assistant_tool_calls_committed",tool_calls:[{call_id:"call",name:"mcp__pi__read",args:'{"path":"fixture"}'}]}}}});
it("checks exact recorded envelope definitions and observed consumed event shape without build gating",()=>{
 expect(BATCH_SCHEMA_SOURCES.map(source=>source.build)).toEqual(["v1414","v1415"]);
 expect(batchBoundarySchemaMatches(frame())).toBe(true);
 expect(committedCalls(frame())).toEqual([{callId:"call",name:"mcp__pi__read",args:{path:"fixture"}}]);
 const bad:any=frame(); delete bad.record.schema_version;
 expect(batchBoundarySchemaMatches(bad)).toBe(false);
 expect(()=>committedCalls(bad)).toThrow(/schema/);
 const payload:any=frame(); payload.record.payload.event.tool_calls[0].args="[]";
 expect(()=>committedCalls(payload)).toThrow(/schema/);
});
