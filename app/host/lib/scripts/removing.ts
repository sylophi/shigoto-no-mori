// What a worktree or a project going takes with it: the tombstone
// protocol an in-app delete or move runs under, the reap of scripts whose
// worktree was removed from outside the app, and the reap of a project's
// scripts and terminals once it is gone.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { Project } from "@shigomori/contracts/schemas";
import * as Registry from "@shigomori/engine/Registry";
import * as Terrier from "@shigomori/engine/Terrier";
import * as Worktrees from "@shigomori/engine/Worktrees";
import { holdRootChecks } from "@host/mirror/registry";
import * as Ops from "../engineOps";
import { loadProjects, refresh } from "../projects";
import { Terminals } from "../terminals/Terminals";
import type { Mark, RunningScriptWorktree } from "./documents";
import type { Marks } from "./marks";
import type { Runs } from "./runs";

export const makeRemoving = ({
  marks,
  runs,
}: {
  readonly marks: Marks;
  readonly runs: Runs;
}) =>
  Effect.gen(function* () {
    const terminals = yield* Terminals;
    const fs = yield* FileSystem.FileSystem;
    const worktrees = yield* Worktrees.Worktrees;
    const registry = yield* Registry.Registry;
    const terrier = yield* Terrier.Terrier;

    // The protocol over the worktrees one mutation removes or moves (a
    // stack cleanup removes several): refuse a concurrent mutation of any
    // of them or one still being created (in `mark.busy`'s words; a
    // removal that must happen, with none, overlaps one under way), mark
    // them with what the mutation does to them, stop their scripts
    // before the mutation (a dev server would otherwise outlive its
    // worktree or keep running in the old path), deal with their mirrors
    // after it, and always clear the marks. The mirrors go after, not
    // before: the engine may refuse the mutation (a dirty tree without
    // --force), and a mirror stopped ahead of a refusal cannot be started
    // again while the branch is still checked out here. The engine is
    // two-way safe, so the gap between the root vanishing and the stop
    // propagates nothing. `mirrorsAfter` stops the mirrors of the
    // worktrees the mutation took (a failed cleanup keeps its worktree,
    // and its mirror with it), or carries them to a moved one's path.
    const withDeletesInflight = Effect.fn("Scripts.withDeletesInflight")(
      function* <A, E, R, E2, R2>(
        worktreeIds: readonly string[],
        mark: Mark,
        run: Effect.Effect<A, E, R>,
        mirrorsAfter: (result: A) => Effect.Effect<unknown, E2, R2>,
      ) {
        const { busy } = mark;
        if (busy !== undefined) {
          for (const id of worktreeIds) yield* marks.assertMutable(id, busy);
        }
        yield* marks.deleting(worktreeIds, mark.kind);
        // The roots vanish under the mutation: the mirror bookkeeping
        // leaves them to `mirrorsAfter` rather than read a move as a
        // removal.
        yield* Effect.acquireRelease(
          Effect.sync(() => holdRootChecks(worktreeIds)),
          (releaseRoots) => Effect.sync(releaseRoots),
        );
        yield* Effect.forEach(worktreeIds, runs.stopWorktree, {
          concurrency: "unbounded",
          discard: true,
        });
        const result = yield* run;
        yield* terminals.closeMissing;
        yield* mirrorsAfter(result);
        return result;
      },
      Effect.scoped,
    );

    // Worktrees a reap pass is investigating or killing. A kill takes
    // seconds in the worst case, and the git enumeration alone can
    // overlap the next watcher event, so a candidate is held for the
    // whole pass: two overlapping passes would otherwise both reap and
    // report the same worktree.
    const reaping = new Set<string>();

    // Killing a dev server the user is still using is worse than leaving
    // a stray one running, so a worktree only counts as removed when git
    // no longer lists it for the project and its checkout is no longer on
    // disk. A listing that succeeds while the checkout's volume is
    // offline still reports the worktree, so an unplugged drive reads as
    // "still there".
    const findRemoved = (
      project: Project,
      candidates: readonly RunningScriptWorktree[],
    ) =>
      Ops.listWorktreeIdentities({ projectId: project.id }).pipe(
        Effect.flatMap((identities) => {
          const liveIds = new Set(identities.map((identity) => identity.id));
          // A repo git can read always lists at least its primary
          // checkout. An empty result means the read went missing, not
          // the worktrees.
          if (liveIds.size === 0) return Effect.succeed([]);
          return Effect.filter(candidates, (candidate) =>
            liveIds.has(candidate.worktreeId)
              ? Effect.succeed(false)
              : fs.exists(candidate.worktreePath).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.map((there) => !there),
                ),
          );
        }),
        // An unreachable repo, a mid-rebase index lock, a transient read
        // error: a fact about the enumeration, not about the worktrees.
        Effect.orElseSucceed((): RunningScriptWorktree[] => []),
        Effect.provideService(Worktrees.Worktrees, worktrees),
      );

    // An `sm rm` run in a terminal leaves a dev server the app started
    // running in a deleted cwd, holding its port: the store's change
    // (host/process/layer.ts) is where the app finds out. The running
    // scripts are the "worktrees that existed" side, since a script only
    // runs in a worktree that was there when it started. Answers the
    // worktrees reaped, and asks git nothing when nothing runs.
    const reapRemoved = Effect.gen(function* () {
      // An in-app delete or move already stopped its scripts under the
      // tombstone.
      const inflight = marks.deleteIds();
      const candidates = runs
        .worktrees()
        .filter(
          ({ worktreeId }) =>
            !inflight.has(worktreeId) && !reaping.has(worktreeId),
        );
      if (candidates.length === 0) return [];
      for (const { worktreeId } of candidates) reaping.add(worktreeId);
      return yield* Effect.gen(function* () {
        const projects = loadProjects();
        const byProject = new Map<string, RunningScriptWorktree[]>();
        for (const candidate of candidates) {
          const group = byProject.get(candidate.projectId);
          if (group) group.push(candidate);
          else byProject.set(candidate.projectId, [candidate]);
        }
        const removed = (yield* Effect.forEach(
          byProject,
          ([projectId, group]) => {
            const project = projects.find((p) => p.id === projectId);
            // An unregistered project's scripts are reaped by its removal.
            return project ? findRemoved(project, group) : Effect.succeed([]);
          },
          { concurrency: "unbounded" },
        )).flat();
        const removedIds = new Set(removed.map((w) => w.worktreeId));
        // The ones still there are released now, so a later, genuine
        // removal isn't held behind this pass.
        for (const { worktreeId } of candidates) {
          if (!removedIds.has(worktreeId)) reaping.delete(worktreeId);
        }
        yield* Effect.forEach(removed, (w) => runs.stopWorktree(w.worktreeId), {
          concurrency: "unbounded",
          discard: true,
        });
        return removed;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const { worktreeId } of candidates) reaping.delete(worktreeId);
          }),
        ),
      );
    }).pipe(Effect.withSpan("Scripts.reapRemoved"));

    // A project gone takes its scripts and terminals, whoever removed it:
    // the app (projects.remove), the doctor's repair, or a terminal's `sm
    // projects remove`, which the store's change tells
    // (host/process/layer.ts). Gone is what a fresh list no longer names,
    // so one a removal kept (terrier still registers it) keeps them. A
    // list that can't be read takes nothing, and neither does a terrier
    // project missing from a list terrier couldn't answer for (it lists
    // none then). The runs are the ones there before the list was read,
    // so a project added again meanwhile keeps a run started since. It
    // re-reads the list the sync readers (the git watcher, the fetch
    // sweep) hold.
    const reapRemovedProjects = Effect.gen(function* () {
      const runsBefore = runs.list().filter(({ interactive }) => interactive);
      const sourceOf = new Map(
        loadProjects().map(({ id, source }) => [id, source ?? "registry"]),
      );
      const listed = yield* refresh.pipe(
        Effect.map((projects) => new Set(projects.map(({ id }) => id))),
        Effect.option,
        Effect.provideService(Registry.Registry, registry),
      );
      if (Option.isSome(listed)) {
        const terrierTold = Option.isNone((yield* terrier.listing).trouble);
        const gone = (projectId: string) =>
          !listed.value.has(projectId) &&
          (terrierTold || sourceOf.get(projectId) === "registry");
        yield* runs.stopRuns(
          new Set(
            runsBefore
              .filter(({ projectId }) => gone(projectId))
              .map(({ runId }) => runId),
          ),
        );
      }
      yield* terminals.closeMissing;
    }).pipe(Effect.withSpan("Scripts.reapRemovedProjects"));

    return {
      withDeletesInflight,
      reapRemovedProjects,
      withDeleteInflight: <A, E, R, E2, R2>(
        worktreeId: string,
        mark: Mark,
        run: Effect.Effect<A, E, R>,
        mirrorsAfter: (result: A) => Effect.Effect<unknown, E2, R2>,
      ) => withDeletesInflight([worktreeId], mark, run, mirrorsAfter),
      reapRemoved,
    };
  });
