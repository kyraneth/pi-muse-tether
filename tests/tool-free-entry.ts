import { registerMuseExtension } from "../index.js";
import { createMuseProvider } from "../src/provider.js";
import { openFixtureHost } from "./fixture-host.js";
import { MUSE_INBOUND_FRAME_LIMIT_BYTES as cap } from "../src/host.js";

/** Real Pi entry with the SDK's fixture transport; never uses an account. */
export default async function (pi: Parameters<typeof registerMuseExtension>[0]) {
  await registerMuseExtension(pi, createMuseProvider({
    openHost:openFixtureHost, promptModes:["replace"], promptMode:"replace",
    instructionMechanisms:["private-settings-fixture"], rawCompletion:true,
  }));
  if (process.env.FIXTURE_STAGE_HISTORY === "1") pi.on("session_start",(_event,ctx)=>{
    const manager=ctx.sessionManager as any, timestamp=Date.now();
    const assistant={role:"assistant",api:"pi-muse-tether",provider:"pi-muse-tether",model:"echo",timestamp,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    manager.appendMessage({role:"user",content:"EARLIER_CONTEXT_SENTINEL\n"+'\\"🙂'.repeat(Math.ceil(cap/8)),timestamp});
    manager.appendMessage({...assistant,content:[{type:"toolCall",id:"historical_lookup",name:"lookup",arguments:{}}],stopReason:"toolUse"});
    manager.appendMessage({role:"toolResult",toolCallId:"historical_lookup",toolName:"lookup",content:[{type:"text",text:"TOOL_RESULT_SENTINEL"}],isError:false,timestamp});
    manager.appendMessage({...assistant,content:[{type:"text",text:"HISTORICAL_ASSISTANT_SENTINEL"}],stopReason:"stop"});
  });
}
