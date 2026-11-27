#!/usr/bin/env bash
# Run from source after npm ci (including its npm cache). Optionally test exact tarball bytes.
set -euo pipefail
IFS=: read -ra dirs <<< "$PATH"
host_path=()
for dir in "${dirs[@]}"; do
  case "$dir" in
    */node_modules/.bin|*/node_modules/.bin/) ;;
    /*) host_path+=("$dir") ;;
  esac
done
PATH=$(IFS=:; printf '%s' "${host_path[*]}")
pi=$(command -v pi) || { printf 'Install Pi on PATH before running this smoke.\n' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd -P)
npm_cache=$(npm config get cache)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/pi-muse-smoke.XXXXXX")
scratch=$(cd "$scratch" && pwd -P)
printf 'Installed Pi: %s\nSmoke evidence: %s\n' "$pi" "$scratch"
mkdir -p "$scratch"/{home,config,data/muse/model-catalog,cache,state,runtime,tmp,agent/npm,cwd}
chmod 700 "$scratch/runtime"
clean=(env -i "PATH=$PATH" "HOME=$scratch/home" "TMPDIR=$scratch/tmp"
  "XDG_CONFIG_HOME=$scratch/config" "XDG_CONFIG_DIRS=$scratch/config"
  "XDG_DATA_HOME=$scratch/data" "XDG_DATA_DIRS=$scratch/data"
  "XDG_CACHE_HOME=$scratch/cache" "XDG_STATE_HOME=$scratch/state" "XDG_RUNTIME_DIR=$scratch/runtime"
  "PI_CODING_AGENT_DIR=$scratch/agent" "PI_CODING_AGENT_SESSION_DIR=$scratch/agent/sessions"
  "npm_config_cache=$npm_cache" PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 CI=1
  "PI_MUSE_TETHER_BINARY=$repo/tests/fixtures/catalog-discovery.py")

if (( $# > 1 )); then
  printf 'Usage: %s [package.tgz]\n' "$0" >&2; exit 1
elif (( $# == 1 )); then
  archive=$(cd "$(dirname "$1")" && printf '%s/%s' "$PWD" "$(basename "$1")")
else
  (cd "$repo"; "${clean[@]}" npm pack --ignore-scripts --offline --json --pack-destination "$scratch") > "$scratch/pack.json"
  archive="$scratch/$(node -p 'require(process.argv[1])[0].filename' "$scratch/pack.json")"
fi
printf '%s\n' '{"packages":["npm:pi-muse-tether"]}' > "$scratch/agent/settings.json"
cd "$scratch/cwd"
"${clean[@]}" npm install --prefix "$scratch/agent/npm" --omit=dev --legacy-peer-deps \
  --offline --ignore-scripts --no-audit --no-fund "$archive"
if [[ -e "$scratch/agent/npm/node_modules/@earendil-works/pi-ai" ]]; then
  printf 'A local pi-ai install would hide host-loader failures.\n' >&2; exit 1
fi
"${clean[@]}" "$pi" --version | tee "$scratch/pi.version"
list() {
  local stage=$1 status=0
  shift
  "${clean[@]}" "$@" "$pi" -ns -np -nc --no-mcp --no-session --list-models pi-muse-tether \
    </dev/null > "$scratch/$stage.stdout" 2> "$scratch/$stage.stderr" || status=$?
  printf '%s\n' "$status" > "$scratch/$stage.exit"
  tee < "$scratch/$stage.stdout"
  tee < "$scratch/$stage.stderr" >&2
  (( status == 0 )) && ! grep -q '^Error:' "$scratch/$stage.stderr"
}
rows() { awk '$1 == "pi-muse-tether" {print $2}' "$scratch/$1.stdout"; }

list load env PI_MUSE_TETHER_LIVE=0
[[ $(rows load) == echo ]] || { printf 'Installed extension failed to load.\n' >&2; exit 1; }

# --list-models cannot see renderer registration. Probe the installed Pi loader,
# not the source extension or a fake ExtensionAPI, with the same tarball.
pi_dist=$(dirname "$(dirname "$(realpath "$pi")")")
installed="$scratch/agent/npm/node_modules/pi-muse-tether/index.ts"
registrations() {
  local stage=$1
  shift
  "${clean[@]}" "$@" node --input-type=module - "$pi_dist/core/extensions/loader.js" "$installed" > "$scratch/$stage.registrations" <<'JS'
import {pathToFileURL} from 'node:url';
import {strict as assert} from 'node:assert';
const {loadExtensions} = await import(pathToFileURL(process.argv[2]).href);
const {extensions,errors} = await loadExtensions([process.argv[3]], process.cwd());
assert.deepEqual(errors, []);
assert.equal(extensions.length, 1);
const e = extensions[0];
const keys = map => [...(map?.keys() ?? [])].sort();
const active = process.env.PI_MUSE_TETHER_NATIVE_SEARCH === '1' && process.env.PI_MUSE_TETHER_STRICT !== '1';
const renderers = keys(e.entryRenderers);
assert.deepEqual(renderers, active ? ['pi-muse-tether:native-search', 'pi-muse-tether:native-search-notice'] : []);
assert.deepEqual(keys(e.tools), []);
assert.deepEqual(keys(e.commands), ['muse-doctor']);
if (active) {
  const example = {phase:'completed',status:'completed',query:'example',sources:[{title:'Example',url:'https://example.org/'}]};
  const row = e.entryRenderers.get('pi-muse-tether:native-search')({data:example}, {expanded:false}, undefined);
  assert.match(row.render(120).join('\n'), /Example.*https:\/\/example\.org\//);
}
console.log(JSON.stringify({renderers,tools:keys(e.tools),commands:keys(e.commands),handlers:keys(e.handlers)}));
JS
}
registrations unset env
registrations off env PI_MUSE_TETHER_NATIVE_SEARCH=0
registrations strict env PI_MUSE_TETHER_NATIVE_SEARCH=1 PI_MUSE_TETHER_STRICT=1
registrations on env PI_MUSE_TETHER_NATIVE_SEARCH=1
cmp "$scratch/unset.registrations" "$scratch/off.registrations"
cmp "$scratch/unset.registrations" "$scratch/strict.registrations"
printf 'Native search registration: unset/off/strict unchanged; on registers only two display renderers.\n'

# Cold tether cache with the vendor's own saved catalogue, but no real login or client.
fixture="$repo/tests/fixtures/provider-catalog-window.json"
node -e 'const fs = require("node:fs"); const c = require(process.argv[1]); c.profileId = "fixture";
  c.models = [{...c.models[0], profileId:c.profileId, modelId:"muse-ember-1.0", displayLabel:"Muse Ember"}];
  fs.writeFileSync(process.argv[2], JSON.stringify(c));' "$fixture" "$scratch/catalogue.json"
cp "$scratch/catalogue.json" "$scratch/data/muse/model-catalog/6d657461__p66697874757265.json"
[[ ! -e "$scratch/cache/pi-muse-tether" ]]
live=(env PI_MUSE_TETHER_LIVE=1 CATALOG_ENTRY_REQUIRE_VENDOR_SEED=1)
list cold "${live[@]}" "CATALOG_ENTRY_FIXTURE=$scratch/catalogue.json" "CATALOG_ENTRY_CALLS=$scratch/cold.calls"
cmp "$scratch/catalogue.json" "$scratch/data/muse/model-catalog/6d657461__p66697874757265.json"
grep -Fq '"method": "model/list"' "$scratch/cold.calls"
if [[ $(rows cold) != $'echo\nmuse-ember-1.0' ]]; then
  printf 'Cold picker failed to register the stubbed authoritative catalogue.\n' >&2; exit 1
fi

# An actual discovery failure must be visible even with no session UI.
list failure "${live[@]}" XDG_DATA_HOME="$scratch/no-vendor-data" \
  "CATALOG_ENTRY_FIXTURE=$scratch/catalogue.json" "CATALOG_ENTRY_CALLS=$scratch/failure.calls"
[[ $(rows failure) == echo ]]
grep -Fq 'Catalogue discovery failed: Non-authoritative catalogue (bundledCatalog)' "$scratch/failure.stderr"
