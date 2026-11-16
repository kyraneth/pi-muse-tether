import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { qualifyClient, runLiveQualificationWorker, schemaCompatibility } from "../src/qualification.js";
import { readQualification, writeQualification, batchEligibility, qualifiedBatchBuilds } from "../src/qualification-records.js";
const fixtures = JSON.parse(readFileSync(new URL("../assets/batch-boundary-schemas.json",import.meta.url),"utf8"));
const build = "1.4.20-R8619.1";
let home:string;
const saved = {...process.env};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(),"qualification-test-"));
  process.env.PI_MUSE_TETHER_QUALIFICATION_HOME = join(home,"records");
  delete process.env.PI_MUSE_TETHER_LIVE;
  delete process.env.PI_MUSE_TETHER_QUALIFICATION_REAL_CONFIG;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env,saved);
  rmSync(home,{recursive:true,force:true});
});
function binary(schema:any = fixtures.schemas[0], options:{help?:string; invalidJson?:boolean} = {}) {
  const path = join(home,"official-fixture.cjs"), calls = join(home,"calls.jsonl");
  // Offline fake binary, not an echo model: reject every command outside the
  // exact read-only version/help/schema pipeline, and enforce the no-update env.
  writeFileSync(path,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(process.env.MUSE_NO_AUTO_UPDATE!=='1')process.exit(90);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,home:process.env.HOME,state:process.env.XDG_STATE_HOME})+'\\n');
if(args[0]==='--version')console.log('Muse Code 1.4.20 (${build})');
else if(args.join(' ')==='schema --help')console.log(${JSON.stringify(options.help ?? "generate-json-schema")});
else if(args.join(' ')==='schema generate-json-schema --help')console.log('--experimental --out');
else if(args.join(' ')==='schema generate-json-schema --experimental --out '+args.at(-1))fs.writeFileSync(path.join(args.at(-1),'msp.schema.json'),${JSON.stringify(options.invalidJson ? "{bad" : JSON.stringify(schema))});
else process.exit(91);
`,{mode:0o700});
  writeFileSync(join(home,".muse-version"),build);
  process.env.PI_MUSE_TETHER_BINARY = path;
  return {path,calls};
}
describe("recorded schema contracts",() => {
  it.each([0,1])("accepts retained schema fixture %i without a build allowlist", index => {
    expect(schemaCompatibility(fixtures.schemas[index]).compatible).toBe(true);
  });
  it("ignores documentation changes, not wire shape changes",() => {
    const candidate = structuredClone(fixtures.schemas[0]);
    candidate.$defs.LogRecordParams.description = "New docs";
    expect(schemaCompatibility(candidate).compatible).toBe(true);
    candidate.$defs.LogRecordParams.properties.subscriptionId.type = "string";
    expect(schemaCompatibility(candidate).compatible).toBe(false);
  });
  it("rejects missing or unresolved contracts",() => {
    expect(schemaCompatibility({}).compatible).toBe(false);
    const candidate = structuredClone(fixtures.schemas[0]);
    candidate.$defs.RawLogRecordEnvelope.properties.stream.$ref = "#/$defs/Missing";
    expect(schemaCompatibility(candidate).compatible).toBe(false);
  });
});
describe("qualification entry point (offline only)",() => {
  it("inspects official help, hashes emitted schema and writes an incomplete record without a model request",async () => {
    const fixture = binary();
    const envBefore = {...process.env};
    const bytes = readFileSync(fixture.path);
    const record = await qualifyClient(build);
    expect(record.build).toBe(build);
    expect(record.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(record.schemaHash).toBe(createHash("sha256").update(JSON.stringify(fixtures.schemas[0])).digest("hex"));
    expect(record.results.offline).toBe(true);
    expect(record.qualified).toBe(false);
    for (const check of Object.values(record.results.live as any)) expect((check as any).status).toBe("not-run");
    expect(readQualification(build)).toEqual(record);
    const calls = readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.map(row=>row.args.slice(0,3))).toEqual([["--version"],["schema","--help"],["schema","generate-json-schema","--help"],["schema","generate-json-schema","--experimental"]]);
    for (const row of calls) {
      expect(row.home).not.toBe(process.env.HOME);
      expect(row.state.startsWith(row.home)).toBe(true);
    }
    expect(readFileSync(fixture.path)).toEqual(bytes);
    expect(process.env).toEqual(envBefore);
  });
  it("matching qualification data enables optional batching without a code change, and identity drift invalidates the cache",async()=>{
    const fixture=binary(), record=await qualifyClient();
    expect(batchEligibility(fixture.path).qualified).toBe(false);
    // Synthetic record exercises only the activation contract, not live coverage.
    expect(()=>writeQualification({...record,qualified:true})).toThrow(/every named live result/);
    const live=Object.fromEntries(Object.keys(record.results.live as any).map(name=>[name,{status:"passed",detail:"SYNTHETIC activation fixture; not a live claim"}]));
    writeQualification({...record,results:{...record.results,live},qualified:true});
    expect(qualifiedBatchBuilds()).toContain(build);
    expect(batchEligibility(fixture.path).qualified).toBe(true);
    writeFileSync(fixture.path,readFileSync(fixture.path,"utf8")+"\n// synthetic executable drift\n");
    expect(batchEligibility(fixture.path).qualified).toBe(false);
  });
  it("offline rechecking preserves live evidence only when executable and schema identities still match",async()=>{
    binary();const first=await qualifyClient();
    const live=Object.fromEntries(Object.keys(first.results.live as any).map(name=>[name,{status:"passed",detail:"SYNTHETIC record-lifecycle fixture; not a live claim"}]));
    writeQualification({...first,results:{...first.results,live,liveEvidence:{source:"SYNTHETIC"}},qualified:true});
    const next=await qualifyClient();
    expect(next.qualified).toBe(true);expect(next.results.live).toEqual(live);
    expect(next.results.liveEvidence).toEqual({source:"SYNTHETIC"});
  });
  it("does not install or retarget a requested historical build",async () => {
    const fixture = binary();
    await expect(qualifyClient("1.4.14-R7309.1")).rejects.toThrow("cannot target historical builds");
    expect(readQualification(build)).toBeUndefined();
    expect(readFileSync(fixture.calls,"utf8").trim().split("\n")).toHaveLength(1);
  });
  it("requires independent live opt-in before probing a client",async () => {
    await expect(qualifyClient(build,true)).rejects.toThrow("PI_MUSE_TETHER_LIVE=1");
    expect(readQualification(build)).toBeUndefined();
  });
  it("does not infer live permission from the environment alone",async () => {
    binary(); process.env.PI_MUSE_TETHER_LIVE = "1";
    const record = await qualifyClient();
    expect(record.qualified).toBe(false);
    expect((record.results.live as any).batchBoundary.status).toBe("not-run");
  });
  it("records incompatible schema as failed, never fully qualified",async () => {
    binary({$defs:{}});
    const record = await qualifyClient();
    expect(record.results.offline).toBe(false);
    expect(record.results.error).toContain("review required");
    expect(record.qualified).toBe(false);
  });
  it("records CLI help/schema failures explicitly instead of fabricating passes",async () => {
    binary(undefined,{help:"different-command"});
    const record = await qualifyClient();
    expect(record.results.offline).toBe(false);
    expect(record.results.error).toContain("does not advertise");
    expect(record.qualified).toBe(false);
  });
  it("records malformed generated JSON as failed",async () => {
    binary(undefined,{invalidJson:true});
    const record = await qualifyClient();
    expect(record.results.offline).toBe(false);
    expect(record.results.error).toBeTruthy();
    expect(record.qualified).toBe(false);
  });
  it("rejects direct worker calls without its explicit isolated environment",async () => {
    await expect(runLiveQualificationWorker("/unused",home,join(home,"result"))).rejects.toThrow("isolated live environment");
  });
});
