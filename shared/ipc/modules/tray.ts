import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  ProjectScopedPayloadSchema,
  WorktreeScopedPayloadSchema,
} from "@shared/schemas";

// The menu bar popover. Its renderer is the same bundle as the main
// window (loaded with ?surface=tray), so it already has the whole
// `window.api` surface for reads; this contract only covers the things
// that are specific to being a popover -- sizing itself, dismissing
// itself, and handing work back to the main window.
export const trayContract = {
  // The popover is content-sized: the renderer measures its panel and
  // tells main how tall the window should be. Main clamps it.
  resize: invoke(
    "tray:resize",
    z.object({ height: z.number().int().positive() }),
    z.void(),
  ),
  // Dismiss without picking anything (Escape, or after an action that
  // should leave the popover closed).
  close: invoke("tray:close", z.void(), z.void()),
  // Focus the main window on a worktree / on a project's new-worktree
  // page. Main raises the window, then broadcasts the navigation to it.
  revealWorktree: invoke(
    "tray:revealWorktree",
    WorktreeScopedPayloadSchema,
    z.void(),
  ),
  revealNewWorktree: invoke(
    "tray:revealNewWorktree",
    ProjectScopedPayloadSchema,
    z.void(),
  ),
  // Show/hide the main window; returns the visibility it settled on so
  // the footer button can relabel without a second round-trip.
  toggleMainWindow: invoke("tray:toggleMainWindow", z.void(), z.boolean()),
  mainWindowVisible: invoke("tray:mainWindowVisible", z.void(), z.boolean()),
  // Fired each time the popover becomes visible. The popover renderer
  // stays mounted between openings, so this is what makes an opening
  // behave like a fresh mount (refetch, reset the filter).
  shown: broadcast("tray:shown", z.void()),
} as const;

export type TrayContract = typeof trayContract;
