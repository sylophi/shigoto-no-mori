// What the terminal `sm`, an agent or the app itself writes to the
// store, in the host: the engine's StoreChanges, which the views re-read
// off (Views.ts), and the pushes the renderer's requests (React Query)
// invalidate on.
import { gitContract } from "@shigomori/contracts/modules/git";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import type { Table } from "@shigomori/engine/StoreChanges";
import * as Terrier from "@shigomori/engine/Terrier";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as MirrorDaemon from "@host/mirror/MirrorDaemon";
import { MIRROR_LABEL_LOCAL_PROJECT } from "@host/mirror/registry";
import * as GitWatcher from "./GitWatcher";
import * as HostPushes from "./HostPushes";
import * as Scripts from "./Scripts";

// The tables behind the rows a project's pages show. The usage log and
// the shared settings have pushes of their own (projects:usageBumped,
// sharedSettings:changed), and the device-wide sweep a change here
// sets off would refetch every page over one of them.
const forest: readonly Table[] = [
  "projects",
  "project_order",
  "worktree_marks",
  "shelf_snapshots",
  "device",
  "device_config",
  "project_config",
  "worktree_data",
  "script_sort",
  "script_lists",
  "agent_sessions",
];

// A write to the forest reaches every window and every viewing device
// as an explicit invalidation push. Window focus will not do: React
// Query refetches only on a blur to focus transition, and the window may
// be focused the whole time an agent works in a terminal beside it.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const pushes = yield* HostPushes.HostPushes;
    const daemon = yield* MirrorDaemon.MirrorDaemon;
    const terrier = yield* Terrier.Terrier;
    const scripts = yield* Scripts.Scripts;
    // A watcher that failed to start has nothing to follow.
    const watcher = yield* Effect.serviceOption(GitWatcher.GitWatcher);
    const follows = yield* FiberSet.make();

    // The terminal may have added or removed a project: re-read the list,
    // terrier's included, which it may have written to (a project gone
    // takes its scripts, and a worktree or project gone its terminals),
    // then follow it with the git-directory watches.
    const followProjects = terrier.invalidate.pipe(
      Effect.andThen(scripts.reapRemovedProjects),
      Effect.andThen(
        Option.match(watcher, {
          onNone: () => Effect.void,
          onSome: (it) => it.reconcile,
        }),
      ),
      Effect.ignoreCause,
    );

    // The app's only chance to notice an `sm rm` run in a terminal, which
    // leaves a script the app started there running in a deleted cwd and
    // holding its port.
    const reapRemoved = scripts.reapRemoved.pipe(
      Effect.flatMap((removed) =>
        Effect.forEach(
          removed,
          (worktree) =>
            pushes.publish(scriptsContract, "stoppedForRemovedWorktree", {
              worktreeId: worktree.worktreeId,
              worktreeName: worktree.worktreeName,
              scriptCount: worktree.scriptCount,
            }),
          { discard: true },
        ),
      ),
      Effect.ignoreCause({
        log: "Warn",
        message: "[scripts] reap after external change failed",
      }),
    );

    const changes = yield* (yield* StoreChanges.StoreChanges).subscribe;
    yield* changes.pipe(
      Stream.filter((tables) => forest.some((table) => tables.has(table))),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          yield* pushes.publish(gitContract, "externalChange", undefined);
          // A title `sm describe` wrote, announced like a git change so a
          // mirror of the worktree carries it now (host/mirror/gitFollow.ts).
          // Which worktree it was is not told, so every mirrored project is.
          const mirrored = new Set(
            (yield* daemon.sessions)
              .map((session) => session.labels[MIRROR_LABEL_LOCAL_PROJECT])
              .filter((projectId) => projectId !== undefined),
          );
          for (const projectId of mirrored) {
            yield* pushes.publish(gitContract, "projectChanged", { projectId });
          }
          yield* FiberSet.run(follows, followProjects);
          yield* FiberSet.run(follows, reapRemoved);
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
