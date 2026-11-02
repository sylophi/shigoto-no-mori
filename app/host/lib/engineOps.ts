// What is left of the app's adapters onto the engine: a landing's verbs
// (a stack's removal, `done`, a merge), whose results are mapped onto
// the shared schemas here, and where a moved worktree went, for the
// mirrors.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Landing from "@shigomori/engine/Landing";
import * as Worktrees from "@shigomori/engine/Worktrees";
import {
  CleanupErrorSchema,
  type DeleteStackResult,
  type MergeMethod,
  type Project,
  WorktreeSchema,
} from "@shigomori/contracts/schemas";
import { asCall, changing, engineFailure } from "./Engine";
import { findProject, findProjectAndWorktree } from "./projects";

const decodeWorktree = Schema.decodeUnknownSync(WorktreeSchema);
const decodeCleanupError = Schema.decodeUnknownSync(CleanupErrorSchema);

const quiet: Landing.Reporter = { report: () => Effect.void, color: true };

// The merged layers of a stack under the worktree `worktreeId` names,
// itself included: what deleteStack removes, resolved and checked.
export const planStack = Effect.fnUntraced(function* (
  project: Project,
  input: { worktreeId: string; force?: boolean; skipCleanup?: boolean },
) {
  return yield* asCall(
    Effect.gen(function* () {
      const located = yield* findProjectAndWorktree(
        project.id,
        input.worktreeId,
      );
      return yield* (yield* Landing.Landing).planRemoveStack(located, {
        force: input.force === true,
        keepBranch: false,
        skipCleanup: input.skipCleanup === true,
      });
    }),
  );
});

// The worktrees a stack's plan names, removed together, and on a
// cleanup failure whatever went before it. `removedOther` hears each of
// the others as it goes, so a removal cut short still tells what went.
export const deleteStack = Effect.fnUntraced(function* (
  project: Project,
  removal: Landing.StackRemoval,
  reporter: Worktrees.Reporter,
  removedOther: (worktreeId: string) => void,
) {
  const cleanup = yield* asCall(
    changing(
      Effect.flatMap(Landing.Landing, (landing) =>
        landing.removeStack(removal, {
          ...reporter,
          removedOther: (removed) =>
            Effect.sync(() => removedOther(removed.id)),
        }),
      ),
      { projectId: project.id, worktreeId: removal.located.worktree.id },
      "remove",
    ),
  );
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
      if (cleanup.error instanceof Worktrees.CleanupFailed) {
        return {
          ok: false,
          removed,
          cleanupError: decodeCleanupError(
            Worktrees.cleanupErrorOf(cleanup.error),
          ),
        } satisfies DeleteStackResult;
      }
      return yield* engineFailure(cleanup.error);
  }
});

// Not forced: the cleanup box shows for a merged PR, but the branch can
// hold commits made since, which only `done`'s own proof refuses to
// delete.
export const finishWorktree = Effect.fnUntraced(function* (
  project: Project,
  worktreeId: string,
) {
  const done = yield* asCall(
    changing(
      Effect.gen(function* () {
        const located = yield* findProjectAndWorktree(project.id, worktreeId);
        return yield* (yield* Landing.Landing).done(located, { force: false });
      }),
      { projectId: project.id, worktreeId },
      "finish",
    ),
  );
  return decodeWorktree(done.worktree);
});

// `stack`: the PR and every open PR under it in its stack, which the
// engine resolves and merges bottom first.
export const mergePullRequest = Effect.fnUntraced(function* (
  project: Project,
  number: number,
  method: MergeMethod,
  options: { stack?: boolean } = {},
) {
  const merged = yield* asCall(
    changing(
      Effect.gen(function* () {
        const registered = yield* findProject(project.id);
        return yield* (yield* Landing.Landing).merge(
          { project: registered, number },
          { method, stack: options.stack === true },
          quiet,
        );
      }),
      { projectId: project.id },
      "merge",
    ),
  );
  return { outcome: merged.outcome };
});

// Where a worktree's folder was moved to, null when it wasn't.
export const worktreeMovedTo = Effect.fnUntraced(function* (fromPath: string) {
  const moved = yield* asCall(
    Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
      worktrees.movedTo(fromPath),
    ),
  );
  return Option.getOrNull(moved);
});
