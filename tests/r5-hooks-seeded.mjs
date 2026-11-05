// Seed independent throwaway package copies, never mutate shared source/production.
import {cp,mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const source=await readFile('src/provider.ts','utf8');
const seeds=[
 ['ignored-payload','const effective=replacement===undefined?payload:replacement;','const effective=payload;'],
 ['missing-response','await options.onResponse?.({status:0,headers:', 'await undefined; /* seeded absent response */ void ({status:0,headers:'],
 ['missing-stream','await options.onProviderStreamEvent?.({transport:', 'await undefined; /* seeded absent stream */ void ({transport:'],
 ['ignored-tool-removal','const effective=replacement===undefined?payload:replacement;','const effective=replacement===undefined?payload:{...replacement,tools:payload.tools};'],
];
const run=async(cwd,args)=>{const child=spawn(process.execPath,args,{cwd,env:process.env,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r);});return {code,out};};
for(const [name,oldText,newText]of seeds){
 assert.equal(source.split(oldText).length,2,'unique seed');
 const root=resolve('..','hooks-seeded',name),copy=join(root,'package');await mkdir(copy,{recursive:true});
 for(const path of ['index.ts','package.json','src','tests','assets','internal'])await cp(path,join(copy,path),{recursive:true});
 await symlink(resolve('node_modules'),join(copy,'node_modules'),'dir').catch(error=>{if(error.code!=='EEXIST')throw error;});
 await writeFile(join(copy,'src/provider.ts'),source.replace(oldText,newText));
 const negativeExits=[];
 for(const path of name==='ignored-tool-removal'?['coding']:['coding','raw']){
  const negative=await run(copy,['tests/r5-hooks-native.mjs',`--${path}-only`]);await writeFile(join(root,`negative-${path}.log`),negative.out);
  assert.notEqual(negative.code,0,`${name}/${path}: seeded missing behavior survived native Pi test`);
  assert.ok(/AssertionError/.test(negative.out),`${name}/${path}: not a test assertion failure: ${negative.out}`);negativeExits.push(negative.code);
 }
 await writeFile(join(copy,'src/provider.ts'),source);
 const restored=await run(copy,['tests/r5-hooks-native.mjs']);await writeFile(join(root,'restored.log'),restored.out);assert.equal(restored.code,0,restored.out);
 console.log(JSON.stringify({seed:name,negativeExits,restoredExit:restored.code,evidence:root}));
}
