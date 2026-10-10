import { terrierContract } from "@shigomori/contracts/modules/terrier";
import type { Handlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Terrier from "@host/lib/terrier";

export const terrierHandlers = {
  readiness: () => Effect.flatMap(Terrier.Terrier, (it) => it.readiness),
} satisfies Handlers<typeof terrierContract, unknown, Terrier.Terrier>;
