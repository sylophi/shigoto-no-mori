import { terrierContract } from "@shigomori/contracts/modules/terrier";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Terrier from "@host/lib/Terrier";

export const terrierHandlers = {
  readiness: () => Effect.flatMap(Terrier.Terrier, (it) => it.readiness),
} satisfies EffectHandlers<typeof terrierContract, unknown, Terrier.Terrier>;
