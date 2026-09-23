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
// by the next focus refetch instead.
//
// One fiber: the three watches feed one Stream, debounced, and each
// element is one poke. The watch handles live in the stream's scope,
// so stopping is interrupting the fiber, and a debounce pending at the
// stop goes with it instead of firing into a moved data dir.
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Queue, Stream } from "effect";
import { invalidateGlobalConfigCache } from "@host/lib/config/global";
import { invalidateAllProjectConfigCaches } from "@host/lib/config/project";
import { dataDir } from "@host/lib/util/paths";
import { selfWroteWithin } from "@host/lib/util/selfWrite";
import { cliChildCount } from "./cliRunner";

const DEBOUNCE_MS = 300;
const SELF_ECHO_MS = 1000;

let running: Fiber.Fiber<void> | null = null;

// Close every watch on the data dir. Called before the data-folder move
// renames the data dir out from under them; the app relaunches right after
// the move anyway, so nothing needs re-watching this session.
export function stopStateWatcher(): void {
  const fiber = running;
  running = null;
  if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
}

// Whether an event names a file the watcher reacts to. Atomic-write
// temp files and the advisory lock churn on every write cycle; only the
// final renames matter. The updater bridge's control files
// (updaterBridge.ts) are app<->CLI plumbing, not user state: reacting
// to them would turn every updater transition and every `sm update`
// run into an app-wide refetch. Prefix match: the request file spawns a
// `.consuming` sibling while being claimed. The running-scripts record
// (scripts/persistence.ts) is the same kind of plumbing, rewritten on
// every script spawn and exit, and so is the control wire's address
// (core/control/server.ts). The depth cap is for the worktrees/ watch:
// worktree checkouts get heavy content churn (dev servers, builds) 3+
// levels deep; only project/worktree directory events matter there.
function relevant(file: string | null, maxDepth: number | undefined): boolean {
  if (file === null) return true;
  if (file.includes(".tmp") || file.endsWith(".lock")) return false;
  if (
    file === "updater.json" ||
    file === "control.json" ||
    file === "running-scripts.json" ||
    file.startsWith("updater-request.json")
  ) {
    return false;
  }
  if (maxDepth !== undefined && file.split("/").length > maxDepth) {
    return false;
  }
  return true;
}

// The relevant, unechoed events of one directory. A directory that
// cannot be watched (missing on a fresh data dir; bootstrap creates it
// before anything writes) or that vanishes later (nuke) contributes
// nothing more, and the other watches carry on.
function dirEvents(
  dir: string,
  recursive: boolean,
  maxDepth?: number,
): Stream.Stream<string | null> {
  return Stream.callback<string | null>((queue) =>
    Effect.acquireRelease(
      // A synchronous throw from fs.watch is the missing-directory
      // case, so it is caught here: inside Effect.sync it would be a
      // defect, which no catch below would see, and it would end the
      // merged stream for the other directories too.
      Effect.sync(() => {
        const onEvent = (_eventType: string, file: string | null): void => {
          if (!relevant(file, maxDepth)) return;
          // Self-echo check at event time, not after the debounce: a
          // self-write arriving after an external event must not
          // cancel the pending refresh that external event deserves.
          if (cliChildCount() > 0 || selfWroteWithin(SELF_ECHO_MS)) return;
          Queue.offerUnsafe(queue, file);
        };
        let watcher: FSWatcher;
        try {
          watcher = watch(dir, { recursive, persistent: false }, onEvent);
        } catch {
          return null;
        }
        watcher.on("error", () => {
          Queue.endUnsafe(queue);
        });
        return watcher;
      }),
      (watcher) =>
        Effect.sync(() => {
          if (watcher === null) Queue.endUnsafe(queue);
          else watcher.close();
        }),
    ).pipe(
      Effect.flatMap((watcher) =>
        watcher === null ? Queue.end(queue) : Effect.succeed(true),
      ),
    ),
  );
}

// `poke` should nudge the renderer to refetch (the caller broadcasts
// the same signal window focus does, which drives React Query's
// refetch-on-focus).
export function startStateWatcher(poke: () => void): void {
  stopStateWatcher();
  // registry.json, state.json and config.json live at the top, with
  // per-project config and worktree data under projects/. worktrees/
  // needs its own recursive watch: an external `sm create` writes no
  // state file at all. The only observable change is the new checkout
  // directory two levels down (worktrees/<project>/<name>), which a
  // non-recursive top-level watch never sees. (In-project and custom
  // layouts sit outside the data dir and aren't covered. The
  // managed-root default is.)
  const worktreesDir = join(dataDir(), "worktrees");
  try {
    mkdirSync(worktreesDir, { recursive: true });
  } catch {
    // Best effort; the watch tolerates a missing dir.
  }
  const events = Stream.mergeAll(
    [
      dirEvents(dataDir(), false),
      dirEvents(join(dataDir(), "projects"), true),
      dirEvents(worktreesDir, true, 2),
    ],
    { concurrency: "unbounded" },
  );
  running = Effect.runFork(
    events.pipe(
      Stream.debounce(DEBOUNCE_MS),
      Stream.runForEach(() =>
        Effect.sync(() => {
          // Contained: a throw would end every watch with a defect
          // nothing reports.
          try {
            invalidateGlobalConfigCache();
            invalidateAllProjectConfigCaches();
            poke();
          } catch (error) {
            console.warn(`[state-watcher] poke threw: ${String(error)}`);
          }
        }),
      ),
    ),
  );
}
