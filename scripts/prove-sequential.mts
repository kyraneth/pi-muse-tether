/** One explicitly authorized native Pi proof. Never part of npm test. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (!process.argv.includes("--live")) throw new Error("Explicit --live authorization required");
const output=process.argv.find(arg=>arg.startsWith("--out="))?.slice(6);
const binary=process.argv.find(arg=>arg.startsWith("--binary="))?.slice(9);
if (!output || !binary || !output.startsWith("/") || !binary.startsWith("/")) throw new Error("--out=<new absolute directory> --binary=<official absolute muse-bin> required");
mkdirSync(output,{mode:0o700});
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const extension=join(root,"index.ts");
writeFileSync(join(output,"left.txt"),"LEFT_29_4f86\n");writeFileSync(join(output,"right.txt"),"RIGHT_29_7c31\n");
const {META_API_KEY:_,...inherited}=process.env;
mkdirSync(join(output,"config/muse"),{recursive:true,mode:0o700});
const login=process.env.MUSE_AUTH_PATH ?? join(process.env.XDG_CONFIG_HOME || join(homedir(),".config"),"muse/auth.json");
symlinkSync(login,join(output,"config/muse/auth.json"));
const env={...inherited,MUSE_NO_AUTO_UPDATE:"1",PI_MUSE_TETHER_LIVE:"1",PI_MUSE_TETHER_BINARY:binary,
 PI_MUSE_TETHER_LEDGER_ORIGIN:"proof",PI_MUSE_TETHER_PROOF_HOME:output,PI_MUSE_TETHER_QUALIFICATION_HOME:join(output,"qualifications"),
 PI_CODING_AGENT_DIR:join(output,"pi-agent"),XDG_STATE_HOME:join(output,"state"),XDG_DATA_HOME:join(output,"data"),XDG_CACHE_HOME:join(output,"cache"),XDG_CONFIG_HOME:join(output,"config")};
const prompt=`Use read to read ${join(output,"left.txt")} and then read ${join(output,"right.txt")}. Do not use any other tools or delegate. Reply with the two exact file values, separated by a space.`;
const result=spawnSync(process.execPath,[join(root,"node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),"--no-extensions","--no-skills","--no-prompt-templates","--no-themes","--no-context-files","--no-mcp","--no-session","-e",extension,"--provider","pi-muse-tether","--model","muse-spark-1.3","--thinking","high","--tools","read","--mode","json","-p",prompt],{cwd:output,env,encoding:"utf8",maxBuffer:Infinity});
writeFileSync(join(output,"pi.jsonl"),result.stdout??"");writeFileSync(join(output,"pi.stderr"),result.stderr??"");
const events=(result.stdout??"").split("\n").filter(line=>line.startsWith("{")).map(line=>JSON.parse(line));
const calls=events.filter(event=>event.type==="tool_execution_start");
const messages=events.filter(event=>event.type==="message_end").map(event=>event.message);
const assistant=messages.filter(message=>message?.role==="assistant");
const text=JSON.stringify(assistant.at(-1)?.content);
const degradationNotices=(result.stderr??"").split("\n").filter(line=>line.includes('"code":"MUSE_FEATURE_DEGRADED"') && line.includes('"feature":"rawLog"'));
const ok=degradationNotices.length===1 && result.status===0 && calls.length===2 && calls.every(call=>call.toolName==="read") && !assistant.some(message=>message.stopReason==="error") && text?.includes("LEFT_29_4f86") && text.includes("RIGHT_29_7c31");
const receipt={ok,degradationNotices,exitCode:result.status,signal:result.signal,binary,requests:"one native Pi prompt; tool continuations only",degradation:"unqualified build: default shipped extension selects sequential tools; real official binary and existing subscription login",toolCalls:calls.map(call=>({name:call.toolName,args:call.args})),assistantStopReasons:assistant.map(message=>message.stopReason),productionInstall:false};
writeFileSync(join(output,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify(receipt,null,2));
if(!ok) process.exitCode=1;
