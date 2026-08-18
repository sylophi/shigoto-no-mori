// Watches the shigomori root so state written by the CLI (or any
// external process) shows up in the app without waiting for window
// focus or a TTL to lapse: an agent running `sm create` in a terminal
// should see the worktree appear in the sidebar within a debounce, not
// on the next alt-tab.
//
// The app's own writes echo through the same watcher, and reacting to
// them turns every usage bump or launcher-log write into an app-wide
// refetch (git spawns per worktree, gh network calls) that targeted
// mutation invalidation already covered. Events are dropped while a
// delegated CLI child runs and within a short window of any app-side
// root write; a genuinely external write in that window is picked up
// by the next focus refetch instead.
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { invalidateGlobalConfigCache } from "../lib/config/global";
import { invalidateAllProjectConfigCaches } from "../lib/config/project";
import { shigomoriRoot } from "../lib/util/paths";
import { selfWroteWithin } from "../lib/util/selfWrite";
import { cliChildCount } from "./cliRunner";

const DEBOUNCE_MS = 300;
const SELF_ECHO_MS = 1000;

const activeWatchers: FSWatcher[] = [];

// Close every watch on the root. Called before the data-folder move
// renames the root out from under them; the app relaunches right after
// the move anyway, so nothing needs re-watching this session.
export function stopStateWatcher(): void {
  for (const watcher of activeWatchers.splice(0)) watcher.close();
}

// `poke` should nudge the renderer to refetch (the caller broadcasts
// the same signal window focus does, which drives React Query's
// refetch-on-focus).
export function startStateWatcher(poke: () => void): void {
  let timer: NodeJS.Timeout | null = null;
  const changed = () => {
    // Self-echo check at event time, not timer time: a self-write
    // arriving after an external event must not cancel the pending
    // refresh that external event deserves.
    if (cliChildCount() > 0 || selfWroteWithin(SELF_ECHO_MS)) return;
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
          // The updater bridge's control files (updaterBridge.ts) are
          // app<->CLI plumbing, not user state: reacting to them would
          // turn every updater transition and every `sm update` run
          // into an app-wide refetch. Prefix match: the request file
          // spawns a `.consuming` sibling while being claimed. The
          // running-scripts record (scripts/persistence.ts) is the same
          // kind of plumbing, rewritten on every script spawn and exit.
          if (
            file === "updater.json" ||
            file === "running-scripts.json" ||
            file?.startsWith("updater-request.json")
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
      activeWatchers.push(watcher);
    } catch {
      // Directory missing (fresh root); bootstrap creates it before
      // anything writes, so nothing to observe yet is fine.
    }
  };
  // registry.json, state.json and config.json live at the root, with
  // per-project config and worktree data under projects/. worktrees/
  // needs its own recursive
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
