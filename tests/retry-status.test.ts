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
  // An old log may omit the optional open-vocabulary kind and status: the recorded
  // stopping reason is then the cause, and nothing renders as `undefined`.
  publishRetryStatus(coding,{nextAttempt:3,maxAttempts:10,retryDelayMs:60000,system:"meta",reason:"upstream connection reset"});
  expect(statuses.at(-1)).toBe("Muse retry 3/10 scheduled in 60000 ms (meta: upstream connection reset)");
  publishRetryStatus(coding,{nextAttempt:3,maxAttempts:10,retryDelayMs:60000,errorKind:"server"});
  expect(statuses.at(-1)).not.toContain("undefined");
 }finally{publishRetryStatus(summary);publishRetryStatus(coding);setRetryStatusListener(undefined);}
});
