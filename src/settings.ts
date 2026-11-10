import { mkdir, writeFile, stat, lstat, readlink, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

// Prior art: jkeskikangas/pi-muse-subscription b83e605e src/home.ts.
// Official configuration docs describe runtime_capabilities. These exact IDs
// come from the pinned prior art; a clean host's plugin registry does not expose
// tbh-reminders, so actual suppression remains an explicit qualification gap.
export const REMINDERS = ["goal-reminder", "verify-reminder", "skill-reminder", "todo-reminder", "memory", "scope-reminder"] as const;
export type SkillsOff = Record<string, Record<string, "off">>;
let loginFault: string | undefined;
export function assertLoginSafe() { if(loginFault)throw new Error(loginFault); }
/** Account-owner authorization: link login metadata only; never read/copy its bytes. */
export async function linkHostLogin(hostRoot:string, realConfigHome:string) {
  assertLoginSafe();
  const real=join(realConfigHome,"muse/auth.json"), link=join(hostRoot,"config/muse/auth.json");
  let before=await stat(real);await symlink(real,link);
  return async()=>{
    let intact=false, missing=false;
    try {
      const privateState=await lstat(link);
      // Boat lazyfs hydration changes st_dev/st_ino without changing this link.
      // Ownership here is the login destination, not filesystem identity: a new
      // symlink to the same target still gives the client the same login file.
      intact=privateState.isSymbolicLink() && await readlink(link)===real;
    } catch (error) { missing=(error as NodeJS.ErrnoException).code==="ENOENT"; }
    if(!intact){loginFault=`Muse login metadata symlink ${missing?"missing":"replaced"}; STOP, retain private config and request account-owner review`;throw new Error(loginFault);}
    const after=await stat(real);
    const metadata={before:{inode:String(before.ino),size:before.size,mtimeMs:before.mtimeMs},after:{inode:String(after.ino),size:after.size,mtimeMs:after.mtimeMs},
      realMetadataChanged:before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs,symlinkIntact:intact};
    // Account-owner observed a normal official-client refresh on main, 2026-11-02:
    // real-file replacement is metadata evidence, NOT a credential incident.
    // Hydration can also change inode/timestamp precision: no refresh/content claim.
    before=after;
    return metadata;
  };
}
/** Official read-only inventory. No model request, timeout or buffer-size cap. */
export async function discoverSkillsOff(binary:string, cwd:string, env:Record<string,string|undefined>):Promise<SkillsOff> {
  const child=spawn(binary,["skills","list","--json"],{cwd,env,stdio:["ignore","pipe","pipe"]});
  let stdout="";child.stdout.setEncoding("utf8");child.stdout.on("data",part=>stdout+=part);
  // Drain diagnostics without persisting user context or credentials.
  child.stderr.resume();
  const exit=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  if(exit!==0)throw new Error(`Muse skill inventory failed (${exit}); no default fallback`);
  const parsed=JSON.parse(stdout),rows=Array.isArray(parsed)?parsed:parsed.skills;
  if(!Array.isArray(rows))throw new Error("Muse skill inventory malformed; no default fallback");
  const off:SkillsOff={};
  for(const row of rows){if(typeof row.scope!=="string"||typeof row.path!=="string")throw new Error("Muse skill inventory lacks scope/path");(off[row.scope]??={})[row.path]="off";}
  return off;
}
export function promptSettings(systemPrompt: string, tools: readonly string[], skillsOff: SkillsOff = {}) {
  if (typeof systemPrompt !== "string") throw new Error("Pi system prompt must be exact text");
  return {
    schema_version: 1,
    // Official permissions docs + permissionProfile/list catalog. This prevents
    // Muse's auto-review judge from clearing a call before Pi reserves it.
    permissions: {schema_version:1,default_profile:":ask-me"},
    run: {
      system_prompt: systemPrompt,
      toolset: tools.map(name => `mcp__pi__${name}`),
      workflow_trigger_mode: "off",
      context_usage_message_enabled: false,
      context_slimming: { meta_context_note_enabled: false, session_identity_enabled: false },
    },
    runtime_capabilities: Object.fromEntries(REMINDERS.map(name => [`plugin:tbh-reminders:reminder:${name}`, {enabled:false}])),
    skills: {activation:skillsOff},
    context: {foreign_personal_rules:false,foreign_personal_skills:false},
  };
}
/** The empty, tether-owned workspace a private-prompt session names. Muse
 * honours run.system_prompt only with an explicit workspaceRoot, and Muse
 * 1.4.15 starts session MCP only in a trusted workspace ("withheld"
 * otherwise). Trusting the user's project would also load its rules files
 * (AGENTS.md) into the model (measured 2026-11-10), so only this empty private
 * directory is trusted. Pi still owns cwd and every tool path. */
export const privateWorkspace = (hostRoot: string) => join(hostRoot, "workspace");
/** Caller owns a unique host root; no shared mutable settings/schema or auth links. */
export async function writePromptSettings(hostRoot: string, systemPrompt: string, tools: readonly string[], skillsOff?: SkillsOff) {
  const xdg = join(hostRoot,"config");
  await mkdir(join(xdg,"muse"),{recursive:true,mode:0o700});
  await mkdir(privateWorkspace(hostRoot),{recursive:true,mode:0o700});
  await writeFile(join(xdg,"muse","settings.json"), JSON.stringify(promptSettings(systemPrompt,tools,skillsOff)),{mode:0o600,flag:"wx"});
  await writeFile(join(xdg,"muse","trust.json"), JSON.stringify({schema_version:1,projects:{[privateWorkspace(hostRoot)]:{decision:"trusted"}}}),{mode:0o600,flag:"wx"});
  return xdg;
}
