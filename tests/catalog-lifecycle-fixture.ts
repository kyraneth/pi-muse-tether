import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {registerMuseExtension} from "../index.js";
import {createMuseProvider} from "../src/provider.js";

/** Native Pi lifecycle fixture: discovery is real MSP against a fake client;
 * all inference on both providers is a local deterministic response. */
export default async function(pi:any) {
  const synthetic=(model:any) => {
    const stream=createAssistantMessageEventStream();
    const message={role:"assistant",api:model.api,provider:model.provider,model:model.id,
      content:[{type:"text",text:"SYNTHETIC_LIFECYCLE_OK"}],stopReason:"stop",timestamp:Date.now(),
      usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}} as const;
    stream.push({type:"done",reason:"stop",message:message as any});stream.end();return stream;
  };
  const provider=createMuseProvider();
  await registerMuseExtension(pi,{...provider,streamViaMuse:synthetic});
  pi.registerProvider("offline-lifecycle",{api:"offline-lifecycle",apiKey:"unused",baseUrl:"offline-lifecycle",streamSimple:synthetic,
    models:[{id:"local",name:"Local lifecycle fixture",reasoning:false,input:["text"],contextWindow:100000,maxTokens:10000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
  pi.registerCommand("fixture-models",{description:"Print current registered models",handler:(_:string,ctx:any)=>{
    const models=ctx.modelRegistry.getAll().filter((m:any)=>m.provider==="pi-muse-tether");
    ctx.ui.notify(JSON.stringify({fixtureModels:models.map((m:any)=>[m.id,m.contextWindow,m.thinkingLevelMap?.high??null])}),"info");
  }});
}
