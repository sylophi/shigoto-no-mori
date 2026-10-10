import { terrierContract } from "@shigomori/contracts/modules/terrier";
import type { Handlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Terrier from "@host/lib/terrier";

export const terrierHandlers: Handlers<
  typeof terrierContract,
  unknown,
  Terrier.Terrier
> = {
  readiness: () => Effect.flatMap(Terrier.Terrier, (it) => it.readiness),
};
