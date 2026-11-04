import {expect,it} from "vitest";
import {importPiHistory} from "../src/history.js";
const current={role:"user",content:"Current request only"};
const render=(messages:any[])=>importPiHistory(messages,m=>m.content);
it("renders ordered inert calls, results, errors and unresolved work; excludes thinking",()=>{
 const history=[{role:"user",content:"Old request"},{role:"assistant",content:[{type:"thinking",thinking:"secret reasoning"},{type:"toolCall",id:"x",name:"bash",arguments:{command:"touch old-effect"}},{type:"toolCall",id:"y",name:"write",arguments:{path:"old.txt",content:"old"}}]},{role:"toolResult",toolName:"bash",toolCallId:"x",isError:true,content:[{type:"text",text:"old error"}]}];
 const text=render([...history,current]);expect(text).toContain("historical DATA");expect(text).toContain('"isError":true');expect(text).toContain("no recorded result; unresolved");expect(text).toContain("old error");expect(text).not.toContain("secret reasoning");expect(text).toContain("NEW USER REQUEST\nCurrent request only");
});
it("rejects unsupported historical content before submission with entry location",()=>{
 expect(()=>render([{role:"user",content:[{type:"image",data:"not-sent",mimeType:"image/png"}]},{role:"assistant",content:[]},current])).toThrow("entry 0 block 0: unsupported image");
});
it("never resumes an unfinished tool-result request",()=>expect(()=>render([{role:"toolResult",content:[]}])).toThrow("new Pi user request"));
