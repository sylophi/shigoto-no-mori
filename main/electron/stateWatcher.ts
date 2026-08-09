// Watches the shigomori root so state written by the sgm CLI (or any
// external process) shows up in the app without waiting for window
// focus or a TTL to lapse: an agent running `sgm create` in a terminal
// should see the worktree appear in the sidebar within a debounce, not
// on the next alt-tab. The app's own writes also trip the watcher --
// harmless, the invalidate + poke is debounced and idempotent.
import { watch } from "node:fs";
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
  const watchDir = (dir: string, recursive: boolean) => {
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
  // worktree data under projects/.
  watchDir(shigomoriRoot(), false);
  watchDir(join(shigomoriRoot(), "projects"), true);
}
