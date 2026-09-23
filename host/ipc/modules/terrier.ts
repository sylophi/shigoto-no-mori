import { terrierContract } from "@shared/ipc/modules/terrier";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { terrierReadiness } from "@host/lib/terrier";
import { hostAttempt, hostHandler } from "@host/runtime";

export const terrierHandlers: Handlers<typeof terrierContract, HandlerContext> =
  {
    readiness: hostHandler(() => hostAttempt(() => terrierReadiness())),
  };
