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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateGlobalConfigCache } from "@host/lib/config/global";
import { invalidateAllProjectConfigCaches } from "@host/lib/config/project";
import { SHELF_SNAPSHOTS_KEY } from "@host/lib/config/store";
import { dataDir, REGISTRY_FILE } from "@host/lib/util/paths";
import * as PromiseAdapter from "@host/lib/util/promiseAdapter";
import { SELF_ECHO_MS, selfWroteWithin } from "@host/lib/util/selfWrite";
import { cliChildCount } from "./cliRunner";

const DEBOUNCE_MS = 300;

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

// A worktree's data file under the projects dir (projects/<pid>/
// worktrees/<id>.json), naming its project: `sm describe` writes the
// title there.
const WORKTREE_DATA_FILE = /^([^/\\]+)[/\\]worktrees[/\\][0-9a-f]{12}\.json$/;

// Files in the data dir that are app<->CLI plumbing or the app's own
// downloads, not user state. The updater bridge's control files
// (updaterBridge.ts): reacting to them would turn every updater
// transition and every `sm update` run into an app-wide refetch. Prefix
// match for the request file, which spawns a `.consuming` sibling while
// being claimed. The running-scripts record (scripts/persistence.ts) is
// rewritten on every script spawn and exit, the control wire's address
// (core/control/server.ts) on every launch, and the villager data
// (host/lib/villagers.ts) is a download the app polls for itself.
const PLUMBING = new Set([
  "updater.json",
  "control.json",
  "running-scripts.json",
  "villagers",
]);

export class StateWatcher extends Context.Service<
  StateWatcher,
  {
    // Close every watch on the data dir, before the data-folder move
    // renames it out from under them. The app relaunches right after
    // the move, so nothing needs re-watching this session.
    readonly release: Effect.Effect<void>;
  }
>()("sm/main/StateWatcher") {}

// `poke` should nudge the renderer to refetch (the caller broadcasts
// the same signal window focus does, which drives React Query's
// refetch-on-focus). It is also handed the projects whose worktree
// data files changed, which a mirror carries to its other side.
const make = (poke: (worktreeDataProjects: ReadonlySet<string>) => void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const watching = yield* FiberHandle.make();
    const root = dataDir();
    const projectsDir = join(root, "projects");
    const worktreesDir = join(root, "worktrees");
    // Best effort: a missing worktrees dir is watched as nothing.
    yield* fs
      .makeDirectory(worktreesDir, { recursive: true })
      .pipe(Effect.ignore);

    let worktreeDataProjects = new Set<string>();
    // Kept current on every registry.json event, suppressed or not, so
    // each one is judged against the write before it.
    let registrySeen = registryBesidesSnapshots();
    const onlySnapshotsMoved = () => {
      const now = registryBesidesSnapshots();
      const same = now !== null && now === registrySeen;
      registrySeen = now;
      return same;
    };

    // One directory's events that count, each as the project whose
    // worktree data file changed, if any. A directory that is missing
    // (a fresh data dir) or vanishes (a nuke) yields nothing.
    const events = (dir: string, recursive: boolean, maxDepth?: number) =>
      fs.watch(dir, { recursive }).pipe(
        Stream.filter(({ path: file }) => {
          // Atomic-write temp files and the advisory lock churn on every
          // write cycle: only the final renames matter.
          if (file.includes(".tmp") || file.endsWith(".lock")) return false;
          // The listing's shelf snapshots (see the header).
          if (file === REGISTRY_FILE && dir === root && onlySnapshotsMoved()) {
            return false;
          }
          if (PLUMBING.has(file) || file.startsWith("updater-request.json")) {
            return false;
          }
          // Depth cap for the worktrees/ watch: worktree checkouts get
          // heavy content churn (dev servers, builds) 3+ levels deep;
          // only project/worktree directory events matter here.
          return maxDepth === undefined || file.split("/").length <= maxDepth;
        }),
        Stream.map(({ path: file }) =>
          dir === projectsDir ? WORKTREE_DATA_FILE.exec(file)?.[1] : undefined,
        ),
        Stream.ignore,
      );

    // registry.json, state.json and config.json live at the top, with
    // per-project config and worktree data under projects/. worktrees/
    // needs its own recursive watch: an external `sm create` writes no
    // state file at all. The only observable change is the new checkout
    // directory two levels down (worktrees/<project>/<name>), which a
    // non-recursive top-level watch never sees. (In-project and custom
    // layouts, and a managed root kept on the project's drive, sit
    // outside the data dir and aren't covered. The managed-root default
    // is.)
    yield* FiberHandle.run(
      watching,
      Stream.mergeAll(
        [
          events(root, false),
          events(projectsDir, true),
          events(worktreesDir, true, 2),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        // Self-echo checked at event time, not when the debounce fires:
        // a self-write arriving after an external event must not cancel
        // the refresh that external event deserves.
        Stream.filter(
          () => cliChildCount() === 0 && !selfWroteWithin(SELF_ECHO_MS),
        ),
        Stream.tap((project) =>
          Effect.sync(() => {
            if (project !== undefined) worktreeDataProjects.add(project);
          }),
        ),
        Stream.debounce(DEBOUNCE_MS),
        Stream.runForEach(() =>
          Effect.sync(() => {
            invalidateGlobalConfigCache();
            invalidateAllProjectConfigCaches();
            const projects = worktreeDataProjects;
            worktreeDataProjects = new Set();
            poke(projects);
          }),
        ),
      ),
    );
    return StateWatcher.of({
      release: FiberHandle.clear(watching).pipe(
        Effect.withSpan("StateWatcher.release"),
      ),
    });
  });

export const layer = (
  poke: (worktreeDataProjects: ReadonlySet<string>) => void,
) => Layer.effect(StateWatcher, make(poke));

// For the data-folder move, which is not Effect yet.
const promiseAdapter = PromiseAdapter.make<StateWatcher>("The state watcher");
export const adapter = promiseAdapter.layer;

// A watcher that is not up has nothing to release.
export function stopStateWatcher(): Promise<void> {
  return promiseAdapter.runIfOpen(
    Effect.gen(function* () {
      yield* (yield* StateWatcher).release;
    }),
  );
}
