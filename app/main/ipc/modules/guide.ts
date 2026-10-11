// The window's guide (contracts' modules/guide.ts): a session bound to
// the window that asks, the user's agent opened on it by the host, and
// the window's own stop.
import { guideContract } from "@shigomori/contracts/modules/guide";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { onGuide } from "../../electron/guide";
import { host } from "../../hostProcess";

export const guideHandlers: Handlers<typeof guideContract, HandlerContext> = {
  ask: async ({ harness, question }, { windowId }) => {
    if (windowId === undefined) throw new Error("Only a window can ask.");
    const session = await onGuide((guide) => guide.start(windowId, harness));
    try {
      await host().guideLaunch({ session, harness, question });
    } catch (error) {
      await onGuide((guide) => guide.end(windowId));
      throw error;
    }
  },
  read: (_, { windowId }) =>
    windowId === undefined ? null : onGuide((guide) => guide.read(windowId)),
  stop: async (_, { windowId }) => {
    if (windowId !== undefined) await onGuide((guide) => guide.end(windowId));
  },
};
