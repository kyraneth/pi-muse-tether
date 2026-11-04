import {expect,it} from 'vitest';
import {importPiHistory} from '../src/history.js';
import {museHistoryInput,museCurrentInput,museHistoryParts} from '../src/image-input.js';
const user=(content:any)=>({role:'user',content});
const old=[user('old'),{role:'assistant',content:[{type:'text',text:'done'}]}];
it('keeps the entire trailing user run current on cold, resume and fork imports',()=>{
 for(const prefix of [[],old]) {
  const messages=[...prefix,user('before'),user('ACTUAL PROMPT'),user('recall')];
  const text=museHistoryInput(messages);
  expect(text).toEqual(prefix.length?expect.stringContaining('NEW USER REQUEST\nbefore\nACTUAL PROMPT\nrecall'):'before\nACTUAL PROMPT\nrecall');
  if(prefix.length)expect(String(text).split('END PI HISTORY JSON')[0]).not.toContain('ACTUAL PROMPT');
  expect(importPiHistory(messages,m=>m.content)).toContain('before\nACTUAL PROMPT\nrecall');
 }
});
it('preserves current images between text from multiple user/custom messages',()=>{
 const image={type:'image',mimeType:'image/png',data:'eA=='};
 const messages=[user('prompt'),user([{type:'text',text:'see'},image]),user('recall')];
 expect(museCurrentInput(messages)).toEqual([{type:'text',text:'prompt'},{type:'text',text:'see'},{type:'image',mediaType:'image/png',base64Data:'eA=='},{type:'text',text:'recall'}]);
 const parts=museHistoryParts([...old,...messages]);
 expect(parts.slice(1)).toEqual(museCurrentInput(messages));
 expect(parts[0].text).toContain('NEW USER REQUEST');
 expect(parts[0].text).not.toContain('PI IMAGE');
});
