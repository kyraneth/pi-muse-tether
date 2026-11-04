// Inherited by real Pi and its MCP child; no provider/network requests.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const deny=kind=>{fs.appendFileSync(process.env.INJECTED_BLOCKED,kind+'\n');throw new Error('INJECTED OFFLINE GUARD: '+kind);};
globalThis.fetch=async()=>deny('fetch');
for(const [owner,key] of [[fs,'readFileSync'],[fsp,'readFile']]){
 const original=owner[key];
 owner[key]=function(path,...args){
  const name=String(path);
  if(/(?:auth|credentials)\.json$/.test(name)&&name!==process.env.INJECTED_EMPTY_AUTH)deny('real-auth-read');
  return original.call(this,path,...args);
 };
}
syncBuiltinESMExports();
