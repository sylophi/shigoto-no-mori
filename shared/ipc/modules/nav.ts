import { z } from "zod";
import { broadcast } from "@shared/ipc/contract";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

export const navContract = {
  openSettings: broadcast("nav:openSettings", z.void()),
  launchById: broadcast("launch:byId", z.string()),
  // Sent to the main window only, by the menu bar popover: "you are now
  // looking at this". Selection in this app *is* the router location,
  // so navigating is the whole of it.
  openWorktree: broadcast("nav:openWorktree", WorktreeScopedPayloadSchema),
  newWorktree: broadcast("nav:newWorktree", ProjectScopedPayloadSchema),
} as const;

export type NavContract = typeof navContract;
