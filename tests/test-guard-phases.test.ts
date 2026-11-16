import {expect,it} from "vitest";
// @ts-ignore Native guard entry point exports its phase coordinator.
import {runTestPhases} from "../scripts/test-guard.mjs";

it.each([[0,0,0],[1,0,1],[0,1,1],[1,1,1]])("runs both phases for Vitest=%i/node:test=%i and returns %i",async(first,second,expected)=>{
 const calls:string[][]=[], reports:string[]=[];
 const code=await runTestPhases(async(_command:string,args:string[])=>{calls.push(args);return calls.length===1?first:second;},(line:string)=>reports.push(line));
 expect(code).toBe(expected);expect(calls).toHaveLength(2);
 expect(calls[0]).toContain("--reporter=verbose");expect(calls[1]).toContain("--test-reporter=spec");
 expect(reports).toContain("[test-guard] START node:test");
 expect(reports).toContain(`[test-guard] END Vitest: exit ${first}`);
 expect(reports).toContain(`[test-guard] END node:test: exit ${second}`);
});

it("still runs node:test if the Vitest process cannot launch",async()=>{
 const calls:string[][]=[], reports:string[]=[];
 const code=await runTestPhases(async(_command:string,args:string[])=>{calls.push(args);if(calls.length===1)throw new Error("synthetic spawn error");return 0;},(line:string)=>reports.push(line));
 expect(code).toBe(1);expect(calls).toHaveLength(2);
 expect(reports.join("\n")).toContain("Vitest failed to launch: synthetic spawn error");
 expect(reports).toContain("[test-guard] END node:test: exit 0");
});
