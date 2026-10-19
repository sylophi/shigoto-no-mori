// The Worktrees service's removals (../Worktrees.ts): one worktree, a
// landed stack's, or one that must go (forced), which the engine commits
// under the tombstone, each announced to every viewer while it goes and
// with its outcome after, and the mirrors of what went stopped.
import { isEntityGoneError } from "@shigomori/contracts/errors";
import type { MovedSource } from "@shigomori/contracts/schemas";
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
import { bookingScripts, ScriptsRunningError } from "./documents";

// How long a forced removal's cleanup may run before it reads as failed.
const FORCED_CLEANUP_MS = 60_000;

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
        readonly expect?: MovedSource | undefined;
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
          { kind: "remove", busy },
          bookingScripts(scripts, notifyScript, (reporter) =>
            Ops.deleteWorktree(
              project,
              {
                worktreeId,
                force: input.force,
                skipCleanup: input.skipCleanup,
                expect: input.expect,
              },
              reporter,
            ),
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
      // Each as it goes, so an interrupt between two removals announces
      // the one already gone as removed.
      const removed = new Set<string>();
      return yield* scripts
        .withDeletesInflight(
          ids,
          { kind: "remove", busy },
          bookingScripts(scripts, notifyScript, (reporter) =>
            Ops.deleteStack(
              project,
              removal,
              reporter,
              (id) => void removed.add(id),
            ),
          ).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                for (const id of outcome.removed) removed.add(id);
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
                    removed.has(id) ? "removed" : "kept",
                  ),
                { discard: true },
              ),
            ),
          ),
        );
    }, Effect.provide(host));

    // A removal that must happen (a nuke, the undo of a create a landing
    // didn't keep): forced, so the port-pool lease is released and the
    // teardown runs like any removal, and when that cleanup fails, again
    // without it, since leaving the worktree behind is not an option. The
    // cleanup runs on a clock: the nuke, or the cancel of something that
    // hung, must not wait on a teardown that hangs the same way. It
    // overlaps a removal already under way rather than wait for it, and
    // reads a worktree that removal took first as removed.
    const forceRemove = Effect.fn("Worktrees.forceRemove")(function* (input: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly cleanupWithin?: number | undefined;
    }) {
      const project = yield* findProject(input.projectId);
      const worktreeId = yield* currentWorktreeId(project.id, input.worktreeId);
      yield* announce(project.id, worktreeId, "removing");
      let removed = false;
      const once = (options: { readonly skipCleanup: boolean }) =>
        bookingScripts(
          scripts,
          () => {},
          (reporter) =>
            Ops.deleteWorktree(
              project,
              {
                worktreeId,
                force: true,
                ...(options.skipCleanup
                  ? { skipCleanup: true }
                  : {
                      cleanupWithin: input.cleanupWithin ?? FORCED_CLEANUP_MS,
                    }),
              },
              reporter,
            ),
        );
      return yield* scripts
        .withDeleteInflight(
          worktreeId,
          { kind: "remove", busy: undefined },
          Effect.gen(function* () {
            // A cleanup the clock stopped reads as a cleanup failure. A
            // worktree already gone (another removal beat this one) is
            // what this one was for.
            const first = yield* once({ skipCleanup: false }).pipe(
              Effect.catch((error) =>
                Effect.succeed({ ok: isEntityGoneError(error) }),
              ),
            );
            removed =
              first.ok ||
              (yield* once({ skipCleanup: true }).pipe(
                Effect.catchIf(isEntityGoneError, () =>
                  Effect.succeed({ ok: true }),
                ),
              )).ok;
          }),
          () => (removed ? stopMirrors([worktreeId]) : Effect.void),
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              announce(project.id, worktreeId, removed ? "removed" : "kept"),
            ),
          ),
        );
    }, Effect.provide(host));

    return { remove, removeStack, forceRemove };
  });
