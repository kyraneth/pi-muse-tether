import { inputParts, turnStartFrameBytes } from "../src/turn-plan.js";
import type { TurnInputPart } from "../src/wire-types.js";

/** Accurate envelope shape for fixture hosts that do not own an SDK transport. */
export const fixtureMeasureTurn = (reasoningEffort="none") => (input:string|TurnInputPart[]) =>
  turnStartFrameBytes({sessionId:"synthetic",input:inputParts(input),reasoningEffort,commandId:"00000000-0000-7000-8000-000000000000"});
