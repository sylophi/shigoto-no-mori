// Watches the shigomori root so state written by the CLI (or any
// external process) shows up in the app without waiting for window
// focus or a TTL to lapse: an agent running `sm create` in a terminal
// should see the worktree appear in the sidebar within a debounce, not
// on the next alt-tab. The app's own writes also trip the watcher --
// harmless, the invalidate + poke is debounced and idempotent.
import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { invalidateGlobalConfigCache } from "../lib/config/global";
import { invalidateAllProjectConfigCaches } from "../lib/config/project";
import { shigomoriRoot } from "../lib/util/paths";

const DEBOUNCE_MS = 300;

// `poke` should nudge the renderer to refetch (the caller broadcasts
// the same signal window focus does, which drives React Query's
// refetch-on-focus).
export function startStateWatcher(poke: () => void): void {
  let timer: NodeJS.Timeout | null = null;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      invalidateGlobalConfigCache();
      invalidateAllProjectConfigCaches();
      poke();
    }, DEBOUNCE_MS);
  };
  const watchDir = (dir: string, recursive: boolean, maxDepth?: number) => {
    try {
      const watcher = watch(
        dir,
        { recursive, persistent: false },
        (_eventType, file) => {
          // Atomic-write temp files and the advisory lock churn on
          // every write cycle; only the final renames matter.
          if (
            file !== null &&
            (file.includes(".tmp") || file.endsWith(".lock"))
          ) {
            return;
          }
          // Depth cap for the worktrees/ watch: worktree checkouts get
          // heavy content churn (dev servers, builds) 3+ levels deep;
          // only project/worktree directory events matter here.
          if (
            maxDepth !== undefined &&
            file !== null &&
            file.split("/").length > maxDepth
          ) {
            return;
          }
          changed();
        },
      );
      watcher.on("error", () => {
        // A vanished directory (nuke) just stops this watcher.
      });
    } catch {
      // Directory missing (fresh root); bootstrap creates it before
      // anything writes, so nothing to observe yet is fine.
    }
  };
  // state.json + config.json live at the root; per-project config and
  // worktree data under projects/. worktrees/ needs its own recursive
  // watch: an external `sm create` writes no state file at all -- the
  // only observable change is the new checkout directory two levels
  // down (worktrees/<project>/<name>), which a non-recursive root
  // watch never sees. (In-project and custom layouts sit outside the
  // root and aren't covered; the managed-root default is.)
  watchDir(shigomoriRoot(), false);
  watchDir(join(shigomoriRoot(), "projects"), true);
  const worktreesDir = join(shigomoriRoot(), "worktrees");
  try {
    mkdirSync(worktreesDir, { recursive: true });
  } catch {
    // Best effort; watchDir tolerates a missing dir.
  }
  watchDir(worktreesDir, true, 2);
}
