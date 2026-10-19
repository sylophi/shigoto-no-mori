import type { accountContract } from "@shigomori/contracts/modules/account";
import type { Handlers } from "@shigomori/contracts/types";
import { makeAccountHandlers } from "@shared/account/handlers";
import { desktopAccount } from "../../electron/account";

export const accountHandlers: Handlers<typeof accountContract> =
  makeAccountHandlers(desktopAccount);
