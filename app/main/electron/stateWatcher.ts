// Watches the shigomori data dir so state written by the CLI (or any
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
// data dir write; a genuinely external write in that window is picked up
// by the next focus refetch instead. The CLI's own writes on the app's
// behalf count as the app's: a delegated verb's (cliRunner.ts notes
// them when it exits), and the use-log bump of a package script the
// app starts through `sm run`, which lands just after the spawn
// (packageScripts.run notes it then). CLI reads mute nothing.
//
// One write a read does make is the full listing's shelf bookkeeping
// (cli/shelf.go): it records a snapshot of a newly shelved worktree,
// and unshelves one that has been worked in since. A registry.json
// change confined to the snapshots is dropped here, like the updater's
// control files below: nobody displays them, and reacting would relist
// every project only to find the snapshot already taken. An unshelve
// clears the shelved mark too, so it goes through like an `sm
// unshelve` from a terminal: one refresh that brings every window and
// peer the row's new place, whose listing then has nothing left to
// write. (An unshelve by the describe right after an app mutation
// falls inside that mutation's echo window instead, and the acting
// window already holds the row.)
import { type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { invalidateGlobalConfigCache } from "@host/lib/config/global";
import { invalidateAllProjectConfigCaches } from "@host/lib/config/project";
import { SHELF_SNAPSHOTS_KEY } from "@host/lib/config/store";
import { dataDir, REGISTRY_FILE } from "@host/lib/util/paths";
import { SELF_ECHO_MS, selfWroteWithin } from "@host/lib/util/selfWrite";
import { cliChildCount } from "./cliRunner";

const DEBOUNCE_MS = 300;

const activeWatchers: FSWatcher[] = [];

// Close every watch on the data dir. Called before the data-folder move
// renames the data dir out from under them; the app relaunches right after
// the move anyway, so nothing needs re-watching this session.
export function stopStateWatcher(): void {
  for (const watcher of activeWatchers.splice(0)) watcher.close();
}

// registry.json without the shelf snapshots, in a form two reads can
// be compared by. Null when it can't be read, which compares as a
// change.
function registryBesidesSnapshots(): string | null {
  try {
    const registry: unknown = JSON.parse(
      readFileSync(join(dataDir(), REGISTRY_FILE), "utf8"),
    );
    if (registry === null || typeof registry !== "object") return null;
    return JSON.stringify({ ...registry, [SHELF_SNAPSHOTS_KEY]: undefined });
  } catch {
    return null;
  }
}

// `poke` should nudge the renderer to refetch (the caller broadcasts
// the same signal window focus does, which drives React Query's
// refetch-on-focus).
export function startStateWatcher(poke: () => void): void {
  let timer: NodeJS.Timeout | null = null;
  // Kept current on every registry.json event, suppressed or not, so
  // each one is judged against the write before it.
  let registrySeen = registryBesidesSnapshots();
  const onlySnapshotsMoved = () => {
    const now = registryBesidesSnapshots();
    const same = now !== null && now === registrySeen;
    registrySeen = now;
    return same;
  };
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
          // The listing's shelf snapshots (see the header).
          if (
            file === REGISTRY_FILE &&
            dir === dataDir() &&
            onlySnapshotsMoved()
          ) {
            return;
          }
          // The updater bridge's control files (updaterBridge.ts) are
          // app<->CLI plumbing, not user state: reacting to them would
          // turn every updater transition and every `sm update` run
          // into an app-wide refetch. Prefix match: the request file
          // spawns a `.consuming` sibling while being claimed. The
          // running-scripts record (scripts/persistence.ts) is the same
          // kind of plumbing, rewritten on every script spawn and exit,
          // and so is the control wire's address (core/control/server.ts).
          if (
            file === "updater.json" ||
            file === "control.json" ||
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
      // Directory missing (fresh data dir); bootstrap creates it before
      // anything writes, so nothing to observe yet is fine.
    }
  };
  // registry.json, state.json and config.json live at the top, with
  // per-project config and worktree data under projects/. worktrees/
  // needs its own recursive watch: an external `sm create` writes no
  // state file at all. The only observable change is the new checkout
  // directory two levels down (worktrees/<project>/<name>), which a
  // non-recursive top-level watch never sees. (In-project and custom
  // layouts sit outside the data dir and aren't covered. The
  // managed-root default is.)
  watchDir(dataDir(), false);
  watchDir(join(dataDir(), "projects"), true);
  const worktreesDir = join(dataDir(), "worktrees");
  try {
    mkdirSync(worktreesDir, { recursive: true });
  } catch {
    // Best effort; watchDir tolerates a missing dir.
  }
  watchDir(worktreesDir, true, 2);
}
