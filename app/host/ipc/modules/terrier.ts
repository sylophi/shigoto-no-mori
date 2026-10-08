import { terrierContract } from "@shigomori/contracts/modules/terrier";
import type { Handlers } from "@shigomori/contracts/types";
import { terrierReadiness } from "@host/lib/terrier";

export const terrierHandlers: Handlers<typeof terrierContract> = {
  readiness: () => terrierReadiness(),
};
