import { navContract } from "@shigomori/contracts/modules/nav";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { isMigrating, takeDeepLink } from "../../electron/windows";

export const navHandlers: Handlers<typeof navContract, HandlerContext> = {
  takeDeepLink: (_, { windowId }) => takeDeepLink(windowId),
  migrating: () => isMigrating(),
};
