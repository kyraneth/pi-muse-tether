import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, closeSync, readSync, fstatSync, statSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
export interface QualificationRecord {build:string;sha256:string;schemaHash:string;results:Record<string,unknown>;qualified:boolean;}
export const QUALIFICATION_CHECKS=["batchBoundary","privatePrompt","sessionMcp","resume","image"] as const;
function validateRecord(record:QualificationRecord,expectedBuild=record.build) {
  checkedBuild(record.build);
  if (record.build !== expectedBuild || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.qualified !== "boolean" || !record.results || typeof record.results !== "object") throw new Error("Invalid qualification record identity/results");
  if (record.qualified && (!/^[a-f0-9]{64}$/.test(record.schemaHash) || record.results.offline !== true || !QUALIFICATION_CHECKS.every(name=>(record.results.live as any)?.[name]?.status === "passed"))) throw new Error("Complete qualification requires matching offline and every named live result");
  return record;
}
export function checkedBuild(build: string) {
  if (!/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(build)) throw new Error(`Invalid Muse build: ${build}`);
  return build;
}
export const qualificationHome = () => process.env.PI_MUSE_TETHER_QUALIFICATION_HOME ?? join(process.env.XDG_DATA_HOME || join(homedir(),".local/share"),"pi-muse-tether/qualifications");
export function binaryHash(path:string) {
  const fd=openSync(path,"r"), hash=createHash("sha256");
  try {
    // Filesystem-reported block size is an I/O chunk, never a workload cap.
    const buffer=Buffer.allocUnsafe(fstatSync(fd).blksize);
    for (;;) { const bytes=readSync(fd,buffer); if (!bytes) break; hash.update(buffer.subarray(0,bytes)); }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
export function schemaHash(binary:string) {
  const out=mkdtempSync(join(tmpdir(),"muse-schema-"));
  try {
    const {META_API_KEY:_,...env}=process.env;
    execFileSync(binary,["schema","generate-json-schema","--experimental","--out",out],{env:{...env,MUSE_NO_AUTO_UPDATE:"1",HOME:out,XDG_CONFIG_HOME:join(out,"config"),XDG_DATA_HOME:join(out,"data"),XDG_CACHE_HOME:join(out,"cache"),XDG_STATE_HOME:join(out,"state")},maxBuffer:Infinity});
    return binaryHash(join(out,"msp.schema.json"));
  } finally {rmSync(out,{recursive:true,force:true});}
}
export function resolveMuseBinary() {
  const path=process.env.PI_MUSE_TETHER_BINARY ?? join(homedir(),".local/bin/muse");
  if (!isAbsolute(path)) throw new Error("Muse binary must be absolute");
  return path;
}
export function selectedClient(binary=resolveMuseBinary()) {
  const {META_API_KEY:_,...env}=process.env;
  const home=mkdtempSync(join(tmpdir(),"muse-version-"));
  let output:string;
  try {
    output=execFileSync(binary,["--version"],{env:{...env,NODE_OPTIONS:undefined,MUSE_NO_AUTO_UPDATE:"1",HOME:home,XDG_CONFIG_HOME:join(home,"config"),XDG_DATA_HOME:join(home,"data"),XDG_CACHE_HOME:join(home,"cache"),XDG_STATE_HOME:join(home,"state")},encoding:"utf8"}).trim();
  } finally { rmSync(home,{recursive:true,force:true}); }
  const build=checkedBuild(/\(([^)]+)\)/.exec(output)?.[1] ?? "unknown");
  // Hash official executable bytes, not the mutable launcher script.
  const executable=binary.endsWith("/muse") ? join(dirname(binary),`muse-bin-${build}`) : binary;
  return {build,binary:executable,sha256:binaryHash(executable)};
}
export function readQualification(build:string):QualificationRecord|undefined {
  const path=join(qualificationHome(),`${checkedBuild(build)}.json`);
  return existsSync(path)?validateRecord(JSON.parse(readFileSync(path,"utf8")),build):undefined;
}
export function writeQualification(record:QualificationRecord) {
  validateRecord(record);
  mkdirSync(qualificationHome(),{recursive:true,mode:0o700});
  const target=join(qualificationHome(),`${checkedBuild(record.build)}.json`), temp=`${target}.${randomUUID()}.tmp`;
  writeFileSync(temp,JSON.stringify(record,null,2)+"\n",{mode:0o600,flag:"wx"});renameSync(temp,target);
}
export const QUALIFICATION_SEEDS:QualificationRecord[] = JSON.parse(readFileSync(new URL("../assets/qualification-seeds.json",import.meta.url),"utf8"));
export const LEGACY_BATCH_BUILDS=QUALIFICATION_SEEDS.map(record=>record.build);
export function clientBuildLabel(binary=resolveMuseBinary()) {
  const direct=/muse-bin-(\d+\.\d+\.\d+-R\d+(?:\.\d+)?)$/.exec(binary)?.[1];
  if (direct) return direct;
  try { return checkedBuild(readFileSync(join(dirname(binary),".muse-version"),"utf8").trim()); } catch { return "unknown build"; }
}
const eligibilityCache=new Map<string,{build:string;qualified:boolean;reason:string}>();
function fileIdentity(path:string) {
  const s=statSync(path,{bigint:true});
  return JSON.stringify([realpathSync(path),String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs),String(s.ctimeNs)]);
}
export function batchEligibility(binary:string) {
  const build=clientBuildLabel(binary), record=build === "unknown build" ? undefined : readQualification(build);
  const seed=QUALIFICATION_SEEDS.find(record=>record.build===build);
  if (!record?.qualified && !seed?.qualified) return {build,qualified:false,reason:"No completed batch qualification record"};
  const executable=binary.endsWith("/muse") ? join(dirname(binary),`muse-bin-${build}`) : binary;
  const evidence=record?.qualified ? record : seed!, identity=fileIdentity(executable), key=JSON.stringify([identity,evidence]);
  const cached=eligibilityCache.get(key); if(cached)return cached;
  const sha256=binaryHash(executable), schema=schemaHash(executable);
  if (identity!==fileIdentity(executable)) return {build,qualified:false,reason:"Official client changed during qualification identity check"};
  const result={build,qualified:evidence.sha256===sha256 && evidence.schemaHash===schema,reason:"Qualification binary/schema identity check"};
  eligibilityCache.set(key,result);return result;
}
export function qualifiedBatchBuilds() {
  const records=existsSync(qualificationHome())?readdirSync(qualificationHome()).filter(name=>/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?\.json$/.test(name)).map(name=>readQualification(name.slice(0,-5))!).filter(record=>record.qualified).map(record=>record.build):[];
  return [...new Set([...LEGACY_BATCH_BUILDS,...records])];
}
export function clientStatus(verify=true) {
  if (!verify) {
    const binary=resolveMuseBinary(), build=clientBuildLabel(binary);
    const record=build === "unknown build" ? undefined : readQualification(build);
    return {build,binary,qualification:record?.qualified || LEGACY_BATCH_BUILDS.includes(build) ? "recorded; runtime binary/schema check pending" : "unqualified; sequential tools",batchPolicy:"qualification + negotiated capability + runtime schema"};
  }
  const client=selectedClient(), record=readQualification(client.build);
  return {...client,qualification:record && record.sha256 === client.sha256 ? record : null, legacyQualified:LEGACY_BATCH_BUILDS.includes(client.build), batchPolicy:"qualification evidence + rawLog grant + runtime schema validation; unknown builds run sequentially"};
}
