// Whether a transfer's source is still what moved, read by the
// teardown's check before its cleanup (on the device that asks) and by
// the removal right before its delete (on the source's own device).
import type { MovedSource } from "./schemas/worktree.ts";

// How the source differs from what moved, given its branch's tip now
// (null when the branch is gone) and the tree of a capture of its
// uncommitted work now (none when it is clean): its branch moved, its
// uncommitted work changed, or it holds uncommitted work the move never
// carried. None while it is still what moved.
export const movedSourceChange = (
  moved: MovedSource,
  now: { readonly tip: string | null; readonly captureTree?: string },
): "moved" | "changed" | "never-moved" | undefined => {
  if (now.tip !== moved.branchTip) return "moved";
  if (now.captureTree === undefined) {
    return moved.captureTree === undefined ? undefined : "changed";
  }
  if (moved.captureTree === undefined) return "never-moved";
  return now.captureTree === moved.captureTree ? undefined : "changed";
};
