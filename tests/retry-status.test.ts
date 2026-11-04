import {it,expect} from "vitest";
import {publishRetryStatus,setRetryStatusListener} from "../src/retry-status.js";
it("auxiliary completion clears only its own retry status, preserving the coding retry",()=>{
 const coding={},summary={};const statuses:any[]=[];setRetryStatusListener(s=>statuses.push(s));
 const params={nextAttempt:2,maxAttempts:10,retryDelayMs:60000,errorKind:"server",httpStatus:503}; // Captured vendor retry values, not tether limits.
 try {
  publishRetryStatus(coding,params);publishRetryStatus(summary);
  expect(statuses.at(-1)).toContain("HTTP 503");
  publishRetryStatus(summary,{...params,errorKind:"transient",httpStatus:undefined});
  expect(statuses.at(-1)).toContain("transient");publishRetryStatus(summary);
  expect(statuses.at(-1)).toContain("HTTP 503");publishRetryStatus(coding);
  expect(statuses.at(-1)).toBeUndefined();
 }finally{publishRetryStatus(summary);publishRetryStatus(coding);setRetryStatusListener(undefined);}
});
