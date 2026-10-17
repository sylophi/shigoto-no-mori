// The Worktrees service's removals (../Worktrees.ts): one worktree, or
// a landed stack's, which the engine commits under the tombstone, each
// announced to every viewer while it goes and with its outcome after,
// and the mirrors of what went stopped.
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ops from "../engineOps";
import * as HostPushes from "../HostPushes";
import {
  currentWorktreeId,
  findProject,
  findProjectAndWorktree,
} from "../projects";
import * as Scripts from "../Scripts";
import { stopMirrorsForWorktree } from "@host/mirror/registry";
import { ScriptsRunningError } from "./documents";

export type RemoveInput = {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly force?: boolean | undefined;
  readonly skipCleanup?: boolean | undefined;
};

const announce = (
  projectId: string,
  worktreeId: string,
  state: "removing" | "removed" | "kept",
) =>
  HostPushes.push(worktreesContract, "removal", {
    projectId,
    worktreeId,
    state,
  });

const stopMirrors = (worktreeIds: readonly string[]) =>
  Effect.forEach(worktreeIds, stopMirrorsForWorktree, {
    concurrency: "unbounded",
    discard: true,
  });

export const makeRemoving = <H>(host: Context.Context<H>) =>
  Effect.gen(function* () {
    const scripts = yield* Scripts.Scripts;

    const remove = Effect.fn("Worktrees.remove")(function* (
      input: RemoveInput & {
        // The transplant's teardown, which must never take down work
        // still running on the source device, refuses where a delete
        // would stop it.
        readonly refuseRunningScripts?: boolean | undefined;
      },
      notifyScript: Scripts.NotifyScriptEvent,
    ) {
      const project = yield* findProject(input.projectId);
      // A mirror's stop names its copy by the id it may have had before
      // a move.
      const worktreeId = yield* currentWorktreeId(project.id, input.worktreeId);
      if (input.refuseRunningScripts === true) {
        const running = scripts.runningIn(worktreeId);
        if (running > 0) {
          return yield* new ScriptsRunningError({ scripts: running });
        }
      }
      // Refused before it is announced, so a second caller's "kept"
      // can't close the first one's removal under every viewer.
      const busy = "This worktree is already being removed.";
      yield* scripts.assertWorktreeMutable(worktreeId, busy);
      yield* announce(project.id, worktreeId, "removing");
      let removed = false;
      return yield* scripts
        .withDeleteInflight(
          worktreeId,
          busy,
          Ops.deleteWorktree(
            project,
            {
              worktreeId,
              force: input.force,
              skipCleanup: input.skipCleanup,
            },
            { notifyScript },
          ).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                removed = outcome.ok;
              }),
            ),
          ),
          (outcome) => (outcome.ok ? stopMirrors([worktreeId]) : Effect.void),
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              announce(project.id, worktreeId, removed ? "removed" : "kept"),
            ),
          ),
        );
    }, Effect.provide(host));

    // The worktrees the engine's plan names are the ones marked,
    // announced and removed, the plan made before any of them is marked.
    const removeStack = Effect.fn("Worktrees.removeStack")(function* (
      input: RemoveInput,
      notifyScript: Scripts.NotifyScriptEvent,
    ) {
      const { project, worktree } = yield* findProjectAndWorktree(
        input.projectId,
        input.worktreeId,
      );
      const removal = yield* Ops.planStack(project, {
        worktreeId: worktree.id,
        force: input.force,
        skipCleanup: input.skipCleanup,
      });
      const ids = removal.worktrees.map(({ id }) => id);
      const busy = "A worktree of this stack is already being removed.";
      for (const id of ids) yield* scripts.assertWorktreeMutable(id, busy);
      for (const id of ids) yield* announce(project.id, id, "removing");
      let removed: readonly string[] = [];
      return yield* scripts
        .withDeletesInflight(
          ids,
          busy,
          Ops.deleteStack(project, removal, { notifyScript }).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                removed = outcome.removed;
              }),
            ),
          ),
          (outcome) => stopMirrors(outcome.removed),
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.forEach(
                ids,
                (id) =>
                  announce(
                    project.id,
                    id,
                    removed.includes(id) ? "removed" : "kept",
                  ),
                { discard: true },
              ),
            ),
          ),
        );
    }, Effect.provide(host));

    return { remove, removeStack };
  });
