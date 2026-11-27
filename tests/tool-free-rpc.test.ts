import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

const here=dirname(fileURLToPath(import.meta.url));
const image={type:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bJkAAAAASUVORK5CYII="};
const readText=(message:any)=>message.content.filter((block:any)=>block.type==="text").map((block:any)=>block.text);

it("native no-tools RPC streams and appends a second multipart turn to the acknowledged host", async () => {
  const home=await mkdtemp(join(tmpdir(),"muse-tool-free-rpc-"));
  const pi=join(home,"pi"), log=join(home,"host.jsonl");
  await mkdir(pi);
  await writeFile(join(pi,"settings.json"),JSON.stringify({images:{autoResize:false}}));
  const child=spawn(resolve(here,"../node_modules/.bin/pi"),["-ne","-ns","-np","-nc","--no-mcp","--no-tools","--mode","rpc","--provider","pi-muse-tether","--model","echo","-e",join(here,"tool-free-entry.ts")],{
    cwd:home,env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:pi,PI_OFFLINE:"1",PI_MUSE_TETHER_LIVE:"0",FIXTURE_HOST_LOG:log,FIXTURE_HOST_TOOL_FREE_CHAT:"1"},
  });
  const exited=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  const rows:any[]=[]; let stderr="";
  child.stderr.on("data", chunk=>stderr+=chunk);
  child.stdin.on("error",()=>{});
  const send=(command:any)=>child.stdin.write(JSON.stringify(command)+"\n");
  send({type:"prompt",id:"first",message:"First fixture marker: LAGOON_57"});
  try {
    for await (const line of createInterface({input:child.stdout})) {
      let row; try { row=JSON.parse(line); } catch { continue; }
      rows.push(row);
      if(row.type==="response" && !row.success) throw Error(row.error);
      if(row.type!=="agent_end") continue;
      if(rows.filter(r=>r.type==="agent_end").length===2) break;
      send({type:"prompt",id:"second",message:"Second prompt with swatch",images:[image]});
    }
  } finally {
    child.stdin.end(); await exited;
    await writeFile(join(home,"rpc.jsonl"),rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
    await writeFile(join(home,"stderr"),stderr);
  }
  expect(await exited,stderr).toBe(0);
  const days=rows.flatMap((row,i)=>row.type==="agent_end"?[i]:[]);
  expect(days).toHaveLength(2);
  for (const [index,end] of days.entries()) {
    const begin=index===0 ? 0 : days[index-1]+1;
    const events=rows.slice(begin,end).filter(r=>r.type==="message_update").map(r=>r.assistantMessageEvent);
    expect(events.filter(event=>event.type==="text_delta").map(event=>event.delta).join("")).toBe(`live fixture answer ${index+1}.Committed-only item.`);
    expect(events.some(event=>event.type==="thinking_delta" && event.delta==="visible fixture thought")).toBe(true);
    expect(events.filter(event=>event.type==="text_start")).toHaveLength(2);
    expect(events.filter(event=>event.type==="text_end")).toHaveLength(2);
    const message=rows[end].messages.filter((m:any)=>m.role==="assistant").at(-1);
    expect(message.stopReason,message.errorMessage).toBe("stop");
    expect(readText(message)).toEqual([`live fixture answer ${index+1}.`,"Committed-only item."]);
  }
  const host=(await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  const runs=host.filter(row=>row.kind==="input");
  expect(host.filter(row=>row.kind==="open")).toHaveLength(1);
  expect(runs.map(row=>row.id)).toEqual([runs[0].id,runs[0].id]);
  expect(runs[1].parts).toEqual([{type:"text",text:"Second prompt with swatch"},{type:"image",mediaType:image.mimeType,base64Data:image.data}]);
  expect(host.find(row=>row.kind==="open")).toMatchObject({purpose:"raw",settings:{run:{toolset:[]}}});
});
