import {expect,it,vi} from 'vitest';
import {promptSettings,REMINDERS,linkHostLogin} from '../src/settings.ts';
import {mkdtemp,mkdir,writeFile,rename,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {museLaunchOptions} from '../src/host.ts';
it('exact prompt, exact declared tool names, all named reminder capabilities disabled',()=>{
 const prompt='\nSYNTHETIC_EXACT_PROMPT\n\n';const s=promptSettings(prompt,['read','bash']);
 expect(s.run.system_prompt).toBe(prompt);expect(s.run.toolset).toEqual(['mcp__pi__read','mcp__pi__bash']);
 for(const name of REMINDERS)expect(s.runtime_capabilities['plugin:tbh-reminders:reminder:'+name]).toEqual({enabled:false});
 expect(s.run.workflow_trigger_mode).toBe('off');expect(s.context).toEqual({foreign_personal_rules:false,foreign_personal_skills:false});
 expect(()=>promptSettings(42 as any,[])).toThrow('exact text');
});
it('private settings require explicit live opt-in and refuse optional MCP fallback',()=>{
 delete process.env.PI_MUSE_TETHER_LIVE;
 const base:any={cwd:process.cwd(),tools:['read'],promptMode:'replace',privatePrompt:{systemPrompt:'test'},echo:false};
 expect(()=>museLaunchOptions(base)).toThrow('PI_MUSE_TETHER_LIVE=1');
 expect(()=>museLaunchOptions({...base,echo:true,mcpServers:{pi:{transport:'stdio',command:'/missing',mode:'optional'}}})).toThrow('no optional fallback');
 const options=museLaunchOptions({...base,echo:true});expect(options.args).not.toContain('--preset');expect(options.env?.META_API_KEY).toBeUndefined();
});
it('allows real-file atomic refresh and records metadata without reading login bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'muse-real-refresh-'));
 try{
  const real=join(root,'real'),host=join(root,'host');await mkdir(join(real,'muse'),{recursive:true});await mkdir(join(host,'config/muse'),{recursive:true});
  await writeFile(join(real,'muse/auth.json'),'synthetic fixture, not a credential');
  const verify=await linkHostLogin(host,real);await verify();
  await writeFile(join(root,'refresh'),'synthetic refreshed fixture');await rename(join(root,'refresh'),join(real,'muse/auth.json'));
  const refreshed=await verify();expect(refreshed.symlinkIntact).toBe(true);expect(refreshed.realMetadataChanged).toBe(true);
  expect(refreshed.after.inode).not.toBe(refreshed.before.inode);
  const stable=await verify();expect(stable.realMetadataChanged).toBe(false);expect(stable.after).toEqual(stable.before);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('same-target links remain safe across identity changes; a regular-file replacement still fences without reading login bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'login-test-'));
 try{
  const real=join(root,'real'),host=join(root,'host');await mkdir(join(real,'muse'),{recursive:true});await mkdir(join(host,'config/muse'),{recursive:true});
  await writeFile(join(real,'muse/auth.json'),'synthetic fixture, not a credential');
  const verify=await linkHostLogin(host,real);const good:any=await verify();expect(good.symlinkIntact).toBe(true);expect(good.after).toEqual(good.before);
  const second=join(root,'second');await mkdir(join(second,'config/muse'),{recursive:true});const verifySecond=await linkHostLogin(second,real);
  await writeFile(join(root,'replacement'),'synthetic replacement');await rename(join(root,'replacement'),join(host,'config/muse/auth.json'));
  await symlink(join(real,'muse/auth.json'),join(root,'replacement-link'));await rename(join(root,'replacement-link'),join(second,'config/muse/auth.json'));
  expect((await verifySecond()).symlinkIntact).toBe(true);
  await expect(verify()).rejects.toThrow('symlink replaced');
 }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['wrong-target','missing'] as const)('%s still fences and latches without reading login bytes',async(mutation)=>{
 vi.resetModules();
 const {linkHostLogin,assertLoginSafe}=await import('../src/settings.ts');
 const root=await mkdtemp(join(tmpdir(),'login-fault-'));
 try{
  const real=join(root,'real'),host=join(root,'host');await mkdir(join(real,'muse'),{recursive:true});await mkdir(join(host,'config/muse'),{recursive:true});
  await writeFile(join(real,'muse/auth.json'),'synthetic fixture, not a credential');
  const verify=await linkHostLogin(host,real),link=join(host,'config/muse/auth.json');
  await rm(link);
  if(mutation==='wrong-target')await symlink(join(root,'other-login'),link);
  const message=mutation==='missing'?'symlink missing':'symlink replaced';
  await expect(verify()).rejects.toThrow(message);
  await rm(link,{force:true});await symlink(join(real,'muse/auth.json'),link);
  expect(()=>assertLoginSafe()).toThrow(message);
 }finally{await rm(root,{recursive:true,force:true});}
});
