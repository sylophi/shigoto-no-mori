import { terrierContract } from "@shared/ipc/modules/terrier";
import type { Handlers } from "@shared/ipc/types";
import { terrierReadiness } from "@host/lib/terrier";

export const terrierHandlers: Handlers<typeof terrierContract> = {
  readiness: () => terrierReadiness(),
};
