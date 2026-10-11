// Landing's cleanup: the landed worktrees and branches going, past the removal guards, and the primary checkout catching up.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { errorDocument } from "../errorDocument.ts";
import * as Git from "../Git.ts";
import type { PullRequestSummary } from "../GitHub.ts";
import * as Paths from "../Paths.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as Worktrees from "../Worktrees.ts";
import {
  LandingRefused,
  type RemoveOptions,
  type Reporter,
  cleanupFailed,
  doneDocument,
} from "./documents.ts";
import type { PullRequestsArea } from "./pullRequests.ts";

export const makeCleanup = ({
  pullRequests,
}: {
  readonly pullRequests: PullRequestsArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const worktrees = yield* Worktrees.Worktrees;
    const binary = (yield* Paths.Paths).binaryName;

    const { refuse } = pullRequests;
    // --- cleanup ---

    // Fast-forwards `branch`, checked out at `worktree`, from
    // `remote/branch`, refusing unless that checkout really is on it: a
    // pull --ff-only advances whatever branch is out.
    const ffPull = (worktree: string, remote: string, branch: string) =>
      Effect.gen(function* () {
        const head = (yield* git.run(worktree, [
          "symbolic-ref",
          "--short",
          "HEAD",
        ])).trim();
        if (head !== branch) {
          return yield* refuse(
            "land",
            "not-on-branch",
            [],
            [worktree, head, branch],
          );
        }
        yield* git.run(worktree, ["pull", "--ff-only", remote, branch]);
      });

    // Best-effort fast-forward of the checkout holding the PR's base branch
    // after the merge, so it sees what landed. An unread base pulls the
    // primary branch. Never fails the land. `identities` lists the
    // project's checkouts, or hands over a listing the caller already has.
    const catchUpBase = (
      target: Worktrees.PrimaryTarget,
      prBase: string,
      identities: Effect.Effect<
        ReadonlyArray<Worktrees.WorktreeIdentity>,
        Git.GitError
      >,
    ) =>
      Effect.gen(function* () {
        const base = prBase === "" ? target.primaryBranch : prBase;
        if (target.remote === "") {
          return {
            catchUpSkipped: `primary ref ${target.primaryRef} has no remote`,
          };
        }
        const listed = yield* Effect.result(identities);
        if (Result.isFailure(listed)) {
          return { catchUpSkipped: errorDocument(listed.failure).error };
        }
        const checkout = listed.success.find(
          (id) => !id.detached && id.branch === base,
        );
        if (checkout === undefined) {
          return { catchUpSkipped: `no checkout is on ${base}` };
        }
        const pulled = yield* ffPull(checkout.path, target.remote, base).pipe(
          Effect.result,
        );
        if (Result.isFailure(pulled)) {
          return { catchUpSkipped: errorDocument(pulled.failure).error };
        }
        return {
          caughtUp: {
            ref: `${target.remote}/${base}`,
            name: checkout.name,
            path: checkout.path,
            isPrimary: checkout.isPrimary,
          },
        };
      });

    // The checkout back on the primary branch (a tracking branch made from
    // the remote ref when needed, then pulled current), and the branch it
    // sat on deleted. The checkout frees the branch first: git refuses to
    // delete one that is out. The branch landed on is never deleted.
    const execDone = (
      project: RegisteredProject,
      target: Worktrees.PrimaryTarget,
      worktree: Worktrees.WorktreeIdentity,
      deleteBranch: boolean,
    ) =>
      Effect.gen(function* () {
        yield* git.checkoutBranch(
          worktree.path,
          target.primaryRef,
          target.remotes,
        );
        if (target.remote !== "") {
          yield* ffPull(worktree.path, target.remote, target.primaryBranch);
        }
        if (deleteBranch && worktree.branch !== target.primaryBranch) {
          yield* git.deleteBranch({
            repo: project.path,
            name: worktree.branch,
            force: true,
          });
          return true;
        }
        return false;
      });

    // The worktree's fresh row, as the app's describe after a mutation,
    // found in `listed`, the project's identities read after it.
    const describeAfterDone = (
      project: RegisteredProject,
      worktree: Worktrees.WorktreeIdentity,
      listed: ReadonlyArray<Worktrees.WorktreeIdentity>,
    ) =>
      Effect.gen(function* () {
        const fresh = listed.find((id) => id.id === worktree.id);
        if (fresh === undefined) return yield* refuse("done", "vanished");
        return yield* worktrees.row({ project, worktree: fresh });
      });

    // The cleanup half of a land: catch the base branch's checkout up, then
    // remove the worktree, or land the primary checkout back on the primary
    // branch. The removal guards ran before the merge.
    const landCleanup = (
      located: Worktrees.Located,
      base: string,
      target: Result.Result<Worktrees.PrimaryTarget, LandingRefused>,
      options: RemoveOptions,
      extra: Record<string, unknown>,
      reporter: Reporter,
    ) =>
      Effect.gen(function* () {
        const { project, worktree } = located;
        if (worktree.isPrimary) {
          if (Result.isFailure(target)) return yield* target.failure;
          const deleted = yield* execDone(
            project,
            target.success,
            worktree,
            !options.keepBranch,
          );
          const listed = yield* worktrees.identities(project);
          const row = yield* describeAfterDone(project, worktree, listed);
          // execDone pulled the primary branch. A PR into another line
          // still leaves that line's checkout behind.
          const caught =
            base !== "" && base !== target.success.primaryBranch
              ? yield* catchUpBase(target.success, base, Effect.succeed(listed))
              : {};
          return doneDocument(row, worktree.branch, deleted, {
            ...extra,
            ...caught,
          });
        }
        const caught = Result.isFailure(target)
          ? { catchUpSkipped: target.failure.message }
          : yield* catchUpBase(
              target.success,
              base,
              worktrees.identities(project),
            );
        const removed = yield* worktrees
          .remove(located, { ...options, preflighted: true }, reporter)
          .pipe(Effect.result);
        if (Result.isFailure(removed)) {
          return cleanupFailed(removed.failure, { ...extra, ...caught });
        }
        return { ok: true, removed: removed.success, ...extra, ...caught };
      });

    const primaryTargetOf = (
      project: RegisteredProject,
      verb: LandingRefused["verb"],
    ) =>
      worktrees.primaryTarget(project).pipe(
        Effect.filterOrFail(
          (target) => target.primaryRef !== "",
          () => refuse(verb, "no-primary", [], [project.path]),
        ),
      );

    // A stack cleanup: the layers landed once the merge is through (merged
    // before, or in the set this merge lands), and the worktrees on them
    // besides this one, each past the removal guards. The primary checkout
    // and a detached one stay.
    const planStackCleanup = (
      located: Worktrees.Located,
      chain: ReadonlyArray<PullRequestSummary>,
      set: ReadonlyArray<PullRequestSummary>,
      options: RemoveOptions,
    ) =>
      Effect.gen(function* () {
        const landing = new Set(
          chain
            .slice(0, -1)
            .filter(
              (layer) =>
                layer.state === "MERGED" ||
                set.some((pr) => pr.number === layer.number),
            )
            .map((layer) => layer.headRefName),
        );
        const listed = yield* worktrees.identities(located.project);
        const others = listed.filter(
          (other) =>
            landing.has(other.branch) &&
            other.id !== located.worktree.id &&
            !other.detached &&
            !other.isPrimary,
        );
        for (const other of others) {
          const guarded = yield* worktrees
            .checkRemovable(
              { project: located.project, worktree: other },
              options.force,
            )
            .pipe(Effect.result);
          if (Result.isFailure(guarded)) {
            return yield* refuse(
              "land",
              "guard",
              [],
              [other.name, other.branch, errorDocument(guarded.failure).error],
            );
          }
        }
        // The primary checkout is never removed. It stays where `done`
        // can land it back on the trunk.
        const primary = located.worktree.isPrimary
          ? undefined
          : listed.find(
              (other) => other.isPrimary && landing.has(other.branch),
            );
        return { landing, others, primary };
      });

    // The removals: the other landed worktrees, then this one through the
    // plain cleanup, whose document carries the landed layers and the
    // worktrees removed for them. The catch-up targets the branch the stack
    // landed on, the bottom's base.
    const execStackCleanup = (
      located: Worktrees.Located,
      pr: PullRequestSummary,
      ownLanded: boolean,
      chain: ReadonlyArray<PullRequestSummary>,
      plan: Effect.Success<ReturnType<typeof planStackCleanup>>,
      target: Worktrees.PrimaryTarget,
      options: RemoveOptions,
      extra: Record<string, unknown>,
      reporter: Reporter,
    ) =>
      Effect.gen(function* () {
        const landed = chain
          .filter(
            (layer) =>
              plan.landing.has(layer.headRefName) ||
              (ownLanded && layer.number === pr.number),
          )
          .map((layer) => ({
            number: layer.number,
            title: layer.title,
            branch: layer.headRefName,
            url: layer.url,
          }));
        const removed: Worktrees.Removed[] = [];
        const stack = { landed, removed };
        const withStack = { ...extra, stack };
        const base = (chain[0] as PullRequestSummary).baseRefName;
        if (plan.primary !== undefined && reporter.note !== undefined) {
          yield* reporter.note(
            `the primary checkout is on landed branch ${plan.primary.branch}. \`${binary} done\` lands it back on ${base}`,
          );
        }
        for (const other of plan.others) {
          const outcome = yield* worktrees
            .remove(
              { project: located.project, worktree: other },
              { ...options, preflighted: true },
              reporter,
            )
            .pipe(Effect.result);
          if (Result.isFailure(outcome)) {
            return cleanupFailed(outcome.failure, withStack);
          }
          removed.push(outcome.success);
        }
        return yield* landCleanup(
          located,
          base,
          Result.succeed(target),
          options,
          withStack,
          reporter,
        );
      });

    return {
      execDone,
      describeAfterDone,
      landCleanup,
      primaryTargetOf,
      planStackCleanup,
      execStackCleanup,
    };
  });

export type CleanupArea = Effect.Success<ReturnType<typeof makeCleanup>>;
