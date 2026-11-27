import { registerMuseExtension } from "../index.js";
import { createMuseProvider } from "../src/provider.js";
import { fixtureState, openFixtureHost } from "./fixture-host.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { writeFile } from "node:fs/promises";

// Synthetic request records: exactly at the Ember API tier boundary (mostly
// cache), then just above it; a repeated notification is not another request.
export const usageRecords = [200_000, 200_001].map((inputTokens, i) => ({
  sourceRange: { last: { id: `request-${i}` } },
  usage: { inputTokens, outputTokens: 7, cacheReadTokens: 190_000, cacheWriteTokens: 1_000 },
  totalTokens: inputTokens + 7,
  cumulative: { cost: { usd: 9, partial: true } },
}));
export default async function (pi: ExtensionAPI) {
  const { tablesPath, ledgerPath } = JSON.parse(process.env.RECIPE_REFERENCE_EVIDENCE!);
  // The test preload gives the process a disposable state directory. Keep only
  // this fixture's ledger in its native test evidence directory for readback.
  process.env.PI_MUSE_TETHER_LEDGER_PATH = ledgerPath;
  await writeFile(tablesPath, JSON.stringify(getBuiltinModels("meta")));
  fixtureState.usageRecords = [usageRecords[0], ...usageRecords];
  fixtureState.quotaPush = { window: { usedPercent: 37 } };
  return registerMuseExtension(pi, createMuseProvider({ openHost: openFixtureHost, toolBatches: false }));
}
