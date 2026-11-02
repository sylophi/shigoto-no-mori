// The Worktrees service's removals (../Worktrees.ts): one worktree, a
// landed stack's, or one that must go (forced), which the engine commits
// under the tombstone, each announced to every viewer while it goes and
// with its outcome after. The engine stops a worktree's mirror before
// its files go (mirror/onDelete.ts). A mirror is one worktree on two
// devices, so a delete takes the other side too. A move's teardown and
// a removal that must happen end the mirror after instead, and a delete
// the other side asked for (`oneSide`) leaves that side to it.
import { isEntityGoneError } from "@shigomori/contracts/errors";
import {
  type CleanupError,
  CleanupErrorSchema,
  type DeleteStackResult,
  type MovedSource,
} from "@shigomori/contracts/schemas";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Landing from "@shigomori/engine/Landing";
import * as EngineWorktrees from "@shigomori/engine/Worktrees";
import { asCall, changing } from "../Engine";
import * as HostPushes from "../HostPushes";
import { currentWorktreeId, findProjectAndWorktree } from "../projects";
import * as Scripts from "../Scripts";
import { MirrorsOnDelete } from "@shigomori/engine/MirrorsOnDelete";
import { MirrorLedger } from "@host/mirror/MirrorLedger";
import { mirrorsOnDelete } from "@host/mirror/onDelete";
import { bookingScripts, ScriptsRunningError } from "./documents";

const decodeCleanupError = Schema.decodeUnknownSync(CleanupErrorSchema);

// How long a forced removal's cleanup may run before it reads as failed.
const FORCED_CLEANUP_MS = 60_000;

export type RemoveInput = {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly force?: boolean | undefined;
  readonly skipCleanup?: boolean | undefined;
};

// A removal's account of a cleanup script that failed, which left the
// worktree in place.
type Removal =
  | { ok: true; cleanupError?: undefined }
  | { ok: false; cleanupError: CleanupError };

// The engine's removal, the scripts it runs to `reporter`, each cleanup
// script on a clock of `cleanupWithin` ms when given.
const removeWorktree = (
  projectId: string,
  input: {
    readonly worktreeId: string;
    readonly force?: boolean | undefined;
    readonly skipCleanup?: boolean | undefined;
    readonly cleanupWithin?: number | undefined;
    readonly expect?: MovedSource | undefined;
  },
  reporter: EngineWorktrees.Reporter,
) =>
  Effect.gen(function* () {
    const located = yield* findProjectAndWorktree(projectId, input.worktreeId);
    return yield* (yield* EngineWorktrees.Worktrees)
      .remove(
        located,
        {
          force: input.force === true,
          keepBranch: false,
          skipCleanup: input.skipCleanup === true,
          ...(input.cleanupWithin === undefined
            ? {}
            : { cleanupWithin: input.cleanupWithin }),
          ...(input.expect === undefined ? {} : { expect: input.expect }),
        },
        reporter,
      )
      .pipe(
        Effect.as<Removal>({ ok: true }),
        Effect.catchTag("CleanupFailed", (failed) =>
          Effect.succeed<Removal>({
            ok: false,
            cleanupError: decodeCleanupError(
              EngineWorktrees.cleanupErrorOf(failed),
            ),
          }),
        ),
      );
  });

// The worktrees a stack's plan names, removed together, and on a
// cleanup failure whatever went before it. `removedOther` hears each of
// the others as it goes, so a removal cut short still tells what went.
const removeStackWorktrees = (
  removal: Landing.StackRemoval,
  reporter: EngineWorktrees.Reporter,
  removedOther: (worktreeId: string) => void,
) =>
  Effect.gen(function* () {
    const cleanup = yield* (yield* Landing.Landing).removeStack(removal, {
      ...reporter,
      removedOther: (removed) => Effect.sync(() => removedOther(removed.id)),
    });
    // The lower layers first and the worktree it ran from last, the order
    // they were removed in.
    const removed = (cleanup.stack?.removed ?? []).map((entry) => entry.id);
    switch (cleanup.kind) {
      case "done":
        return { ok: true, removed } satisfies DeleteStackResult;
      case "removed":
        return {
          ok: true,
          removed: [...removed, cleanup.removed.id],
        } satisfies DeleteStackResult;
      case "failed":
        if (cleanup.error instanceof EngineWorktrees.CleanupFailed) {
          return {
            ok: false,
            removed,
            cleanupError: decodeCleanupError(
              EngineWorktrees.cleanupErrorOf(cleanup.error),
            ),
          } satisfies DeleteStackResult;
        }
        return yield* Effect.fail(cleanup.error);
    }
  });

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

// The other side of a worktree's mirror left alone.
const thisSideOnly = Effect.provideServiceEffect(
  MirrorsOnDelete,
  mirrorsOnDelete("this"),
);

export const makeRemoving = <H>(host: Context.Context<H>) =>
  Effect.gen(function* () {
    const scripts = yield* Scripts.Scripts;
    const ledger = yield* MirrorLedger;

    const stopMirrors = (worktreeIds: readonly string[]) =>
      Effect.forEach(worktreeIds, ledger.stopMirrorsForWorktree, {
        concurrency: "unbounded",
        discard: true,
      });

    const remove = Effect.fn("Worktrees.remove")(function* (
      input: RemoveInput & {
        // The transplant's teardown, which must never take down work
        // still running on the source device, refuses where a delete
        // would stop it.
        readonly refuseRunningScripts?: boolean | undefined;
        readonly expect?: MovedSource | undefined;
        readonly oneSide?: boolean | undefined;
      },
      notifyScript: Scripts.NotifyScriptEvent,
    ) {
      // A mirror's stop names its copy by the id it may have had before
      // a move.
      const worktreeId = yield* currentWorktreeId(
        input.projectId,
        input.worktreeId,
      );
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
      yield* announce(input.projectId, worktreeId, "removing");
      let removed = false;
      // A move's teardown: the worktree lives on on the device it went
      // to, so the copy of its mirror stays.
      const moved = input.expect !== undefined;
      return yield* scripts
        .withDeletesInflight(
          [worktreeId],
          { kind: "remove", busy },
          bookingScripts(scripts, notifyScript, (reporter) =>
            asCall(
              changing(
                removeWorktree(
                  input.projectId,
                  {
                    worktreeId,
                    force: input.force,
                    skipCleanup: input.skipCleanup,
                    expect: input.expect,
                  },
                  reporter,
                ),
                { projectId: input.projectId, worktreeId },
                "remove",
              ),
            ).pipe(
              moved || input.oneSide === true
                ? thisSideOnly
                : (deleting) => deleting,
            ),
          ).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                removed = outcome.ok;
              }),
            ),
          ),
          (outcome) =>
            outcome.ok && moved ? stopMirrors([worktreeId]) : Effect.void,
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              announce(
                input.projectId,
                worktreeId,
                removed ? "removed" : "kept",
              ),
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
      const located = yield* findProjectAndWorktree(
        input.projectId,
        input.worktreeId,
      );
      const { project } = located;
      const removal = yield* asCall(
        Effect.flatMap(Landing.Landing, (landing) =>
          landing.planRemoveStack(located, {
            force: input.force === true,
            keepBranch: false,
            skipCleanup: input.skipCleanup === true,
          }),
        ),
      );
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
            asCall(
              changing(
                removeStackWorktrees(
                  removal,
                  reporter,
                  (id) => void removed.add(id),
                ),
                { projectId: project.id, worktreeId: located.worktree.id },
                "remove",
              ),
            ),
          ).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                for (const id of outcome.removed) removed.add(id);
              }),
            ),
          ),
          () => Effect.void,
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
      const worktreeId = yield* currentWorktreeId(
        input.projectId,
        input.worktreeId,
      );
      yield* announce(input.projectId, worktreeId, "removing");
      let removed = false;
      const once = (options: { readonly skipCleanup: boolean }) =>
        bookingScripts(
          scripts,
          () => {},
          (reporter) =>
            asCall(
              changing(
                removeWorktree(
                  input.projectId,
                  {
                    worktreeId,
                    force: true,
                    ...(options.skipCleanup
                      ? { skipCleanup: true }
                      : {
                          cleanupWithin:
                            input.cleanupWithin ?? FORCED_CLEANUP_MS,
                        }),
                  },
                  reporter,
                ),
                { projectId: input.projectId, worktreeId },
                "remove",
              ),
            ).pipe(thisSideOnly),
        );
      return yield* scripts
        .withDeletesInflight(
          [worktreeId],
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
              announce(
                input.projectId,
                worktreeId,
                removed ? "removed" : "kept",
              ),
            ),
          ),
        );
    }, Effect.provide(host));

    return { remove, removeStack, forceRemove };
  });
