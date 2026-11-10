# pi-muse-tether


Use your Muse Code subscription in [Pi](https://github.com/earendil-works/pi), through the official Muse client.

Hi, I do most of my work in Pi and I also pay for Muse Code. While Meta has not been magnanimous enough to let us use our subscription directly in third-party harnesses, it still offers an [official SDK](https://github.com/meta-models/muse-code-sdk) for building clients around its installed coding agent. Pi is my main harness and I don't want to be swapping coding agents, and most importantly I don't want to juggle identities and system prompts. The goal of this tether is to unlock the high limits a subscription allows while using your own Pi custom prompt as much as possible, staying lighter on the system prompt than the less-than-optimal vendor harnesses, and not having to go through the API. I wrote it with a coding agent.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/flow-dark.svg">
  <img alt="Pi sends the prompt, tools and history through the tether and the official Muse client to the model. A tool call comes back the same way to Pi, which runs the tool and saves the result. The result then goes back to the model." width="700" src="assets/flow-light.svg">
</picture>

## Who it's for

This is for you if you've built your workflow around Pi, with your own system prompt, skills, extensions and subagents, and you have a Muse subscription. Muse becomes one more entry in `/model`. You can switch to it in the middle of a session and switch back later, and Pi keeps the whole conversation. Pi's hooks keep working.

## Install

Sign in with the official Muse Code client first. You need Node 24 or newer. I tested this with Pi 1.5.0 and Muse Code 1.4.14 and 1.4.15; see the version policy below.

```sh
pi install npm:pi-muse-tether
PI_MUSE_TETHER_LIVE=1 pi --provider pi-muse-tether --model muse-spark-1.3
```

Keep `PI_MUSE_TETHER_LIVE=1` set whenever you want to use Muse. Without it you only get an offline test model. If it worked, the Muse models your account can use appear under `pi-muse-tether` in `/model`, and `/muse-doctor` shows the local versions it found.

## Muse Code version policy

The minimum client is **1.4.14**, the oldest version qualified for the tether’s private-XDG prompt/isolation recipe. The tested ceiling is **1.4.15**. Older or unparseable clients are refused. Newer clients warn once per version per Pi process and continue, **not yet qualified**, including private-settings prompt delivery. Set `PI_MUSE_TETHER_STRICT_VERSION=1` to refuse clients above the tested ceiling instead. `/muse-doctor` reports the range and whether the installed client exceeds it. This policy never updates your client.

The SDK remains independently pinned to **`@muse-code/sdk` 1.4.14**; it need not equal the client version. This permits forward client use, not a claim of SDK/client compatibility qualification. The experimental `rawLog`/committed-tool-batch protocol is different: its payload is qualified per exact build, currently **1.4.14-R7309.1** and **1.4.15-R8339.1**, so it refuses every other build even when catalogue discovery and non-batch sessions are allowed with a warning. **Shipped live coding sessions use this batch protocol by default**, so on an unqualified newer build the picker can populate but live coding still refuses before submission. There is no silent single-tool fallback.

Muse 1.4.15 changed two things the tether now handles. It starts session tool servers after `session/start` returns, so the tether waits (via `mcpServer/readInventory`) until its tool server is connected with every Pi tool before the first turn; a withheld or failed server stops before any model request. It also starts session tool servers only in a trusted workspace. The tether names an empty, private, tether-owned workspace and trusts only that one; it never trusts your project, because a trusted project also loads its rules files (for example `AGENTS.md`) into the model. Pi still owns the working directory and every tool path.

## Models in the picker

With live mode enabled, the tether reads the official client’s `model/list`. Every valid Muse catalogue row appears with its own context/output limits and supported thinking levels; there is no model allowlist. New client models do not need a tether code change. The catalogue is read again after each agent run, and the provider is re-registered only when the exposed models or their metadata change. Discovery failure removes live entries, keeps the offline `echo` model, and is reported by `/muse-doctor`.

Each catalogue `<id>` offers its normal route (contributor mode off). Only models with verified contributor support also offer `<id>-contributor` (Contributor, mode on): currently Spark 1.3, Spark 1.2, Wonder 1.0 and Wonder Full 1.0. **Ember 1.0 has only a Normal route**: the client ignores contributor mode for Ember and the API has no Ember contributor model. Future models appear normally without a tether update; contributor routes require verifying the client's on/off wire model and the contributor model's API support, then adding the native ID to the documented `VERIFIED_CONTRIBUTOR_MODEL_IDS` constant in `src/model-route.ts`. For backward compatibility, **`muse-spark-1.3` stays contributor-on**, labelled Contributor; `muse-spark-1.3-contributor` is an explicit alias for that same native model and mode. Existing Wonder names and modes are unchanged. Contributor suffixes select CLI recipes, not native catalogue IDs. The `-contributor` suffix is reserved for these local routes: a native catalogue row using it is skipped with a named `/muse-doctor` diagnostic, without hiding other models.

Only thinking levels present in that model’s catalogue are offered; unsupported levels are refused before submission (for example, Spark 1.2 `max`). Unknown prices remain `null`, labelled **pricing unknown**; no model borrows another’s rates. Assistant messages report `responseModel` from the selected recipe: the native ID for Normal, or `<id>-contributor` for Contributor. Its source is marked derived, not response-attested; catalogue availability alone does not prove physical response identity or contributor support.

## How it works

The tether starts the official Muse client in the background and passes it Pi's system prompt, tools and history. When the model asks for a tool, the call comes back to Pi, as the diagram shows. Pi runs it under its normal guards and saves the result to its own history, and only then does the tether send the result back to Muse.

## How close it is to the direct API

I ran two real coding tasks through each route, once per route, on a build from just before this release. These are single runs, so read them as a rough comparison. [How I measured](docs/DETAILS.md#how-i-measured).

| | Tether | Direct API |
|---|---|---|
| Input read from cache, whole run | 89.8% | 92.2% |
| Input read from cache, turns 2 to 5 | 84, 92, 98, 99% | 84, 98, 98, 100% |
| Tools run by Pi | 261 | 257 |
| Input read from cache, first turn after a resume | 0 of 230k | 222k of 226k |

The last row is the difference you will notice most.

## Why not something else

| Option | Why I didn't use it |
|---|---|
| Pi with the direct API | It works well and I used it as my baseline, but you pay per token. |
| Packages that reuse your Muse login to call the API themselves | The login belongs to the official client, and I don't want my account depending on a route Muse didn't provide. |
| Wrappers where Muse runs the tools | I want Pi's guards, hooks and tools to apply, which is the reason I use Pi. |
| [pi-muse-subscription](https://github.com/jkeskikangas/pi-muse-subscription) | This is the closest project and I learned how to replace the system prompt from it. I built my own so that it shares one tested core with my Claude tether. |

## When not to use it

- You restart Pi often in long sessions. A restart starts a new Muse client, so the next turn begins with a cold cache and processes the whole history again.
- You need control over retries. Muse retries some server errors by itself, and I found no way to turn that off.
- Your tool results must reach the model unchanged. Muse sometimes replaces secret-looking text with `[REDACTED]`, even in harmless prose. Declared loss continues with source/position evidence in the ledger, including uncertain alignments; it does not prove the model saw the original. Literal markers may already be source text.
- You need the model to see every image your tools return. Images no longer kill the turn, but I can't prove what the model saw. It read PNG and JPEG correctly in small tests, but with six images at once it got the last JPEG wrong and said it couldn't see the GIF and WebP. Images attached to a tool error never reach it, because the official client drops them. See [details](docs/DETAILS.md).
- Your tools run for a very long time. I tested one that ran for 5 minutes, and I don't know how much longer one can run.
- You're on a datacenter network with IPv6. On some of these, Muse returned an empty model list while the same account worked over IPv4. The tether stops and tells you when this happens.

## More

This is an independent project, and neither Muse nor Meta made it. The technical details are in [docs/DETAILS.md](docs/DETAILS.md). Please report problems in the [issues](https://github.com/kyraneth/pi-muse-tether/issues). [MIT license](LICENSE).
