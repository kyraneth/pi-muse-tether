/** Derive wire types through the public SDK facade, not deep/internal imports. */
import type { SendUserTurnOptions } from "@muse-code/sdk";
export type TurnInputPart = SendUserTurnOptions<unknown>["input"][number];
export type ReasoningEffort = NonNullable<
  SendUserTurnOptions<unknown>["reasoningEffort"]
>;
