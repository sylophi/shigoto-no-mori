// The window's guide (contracts' modules/guide.ts): a session bound to
// the window that asks, the user's agent opened on it by the host, and
// the window's own stop.
import { guideContract } from "@shigomori/contracts/modules/guide";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { onGuide } from "../../electron/guide";

export const guideHandlers: Handlers<typeof guideContract, HandlerContext> = {
  ask: ({ harness, question }, { windowId }) => {
    if (windowId === undefined) throw new Error("Only a window can ask.");
    return onGuide((guide) => guide.ask(windowId, harness, question));
  },
  read: (_, { windowId }) =>
    windowId === undefined ? null : onGuide((guide) => guide.read(windowId)),
  stop: async (_, { windowId }) => {
    if (windowId !== undefined) await onGuide((guide) => guide.end(windowId));
  },
};
