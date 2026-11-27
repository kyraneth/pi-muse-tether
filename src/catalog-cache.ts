import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { binaryIdentity, statIdentity } from "./cli-version.js";
import { museCatalogAssessment } from "./catalog.js";
import { resolveMuseBinary } from "./qualification-records.js";

export function authoritativeCatalogue(catalogue: any) {
  return catalogue?.source === "providerCatalog" && catalogue.providerId === "meta" &&
    typeof catalogue.profileId === "string" && catalogue.profileId.length > 0 && Array.isArray(catalogue.models) &&
    (catalogue.models.length === 0 || museCatalogAssessment(catalogue).valid.length > 0);
}

export async function catalogueIdentity(executable?:string): Promise<string | undefined> {
  try {
    const binary = await binaryIdentity(executable ?? resolveMuseBinary());
    if (!binary) return;
    const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    if (!isAbsolute(root)) return;
    const config = await realpath(join(root, "muse"));
    const files = await readdir(config, {withFileTypes:true});
    if (!files.some(file => file.name === "auth.json")) return;
    // Metadata only. Bind to config/profile changes (including file additions),
    // symlink destinations and the executable selected by the official launcher.
    const fingerprints = await Promise.all(files.map(file => file.name).sort().map(async name =>
      [name, await statIdentity(await realpath(join(config, name)))]));
    // A selector/config override outside this recipe makes identity uncertain.
    if (Object.keys(process.env).some(name=>/^MUSE_(?:PROFILE|CONFIG|HOME)(?:_|$)/.test(name))) return;
    return createHash("sha256").update(JSON.stringify([binary, root, config, fingerprints])).digest("hex");
  } catch { return undefined; }
}

/** Private host settings may select a different profile. A live admission
 * refreshes a display snapshot only when the official source/profile agrees. */
export async function refreshCatalogueFromHost(before:string|undefined, executable:string, catalogue:any) {
  if (!before || !authoritativeCatalogue(catalogue) || before !== await catalogueIdentity(executable)) return;
  const snapshot=readCatalogue(before);
  if (snapshot?.profileId === catalogue.profileId) saveCatalogue(before,catalogue);
}

function snapshotPath() {
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "pi-muse-tether", "catalogue.json");
}

export function readCatalogue(identity: string | undefined) {
  if (!identity) return;
  try {
    const saved = JSON.parse(readFileSync(snapshotPath(), "utf8"));
    if (saved.identity === identity && authoritativeCatalogue(saved.catalogue)) return saved.catalogue;
  } catch { /* A missing or unusable snapshot is a cache miss. */ }
}

export function saveCatalogue(identity: string | undefined, catalogue: unknown) {
  if (!identity || !authoritativeCatalogue(catalogue)) return;
  const target = snapshotPath(), temp = `${target}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(target), {recursive:true,mode:0o700});
    writeFileSync(temp, JSON.stringify({identity, catalogue}), {mode:0o600,flag:"wx"});
    renameSync(temp,target);
  } catch { /* Picker metadata is disposable; never require a writable cache. */ }
  finally { try { rmSync(temp,{force:true}); } catch { /* Non-authoritative temp. */ } }
}
