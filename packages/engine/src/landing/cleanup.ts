// Landing's cleanup: the landed worktrees and branches going, past the removal guards, and the primary checkout catching up.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { errorDocument } from "../errorDocument.ts";
import * as Git from "../Git.ts";
import * as GitHub from "../GitHub.ts";
import type { PullRequestSummary } from "../GitHub.ts";
import * as Paths from "../Paths.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as Worktrees from "../Worktrees.ts";
import {
  type CatchUp,
  LandingRefused,
  type RemoveOptions,
  type Reporter,
  cleanupFailed,
  doneDocument,
} from "./documents.ts";
import type { PullRequestsArea } from "./pullRequests.ts";

// The commits named in a refusal: the first three, and how many more.
const named = (commits: ReadonlyArray<string>) =>
  commits.length > 3
    ? `${commits.slice(0, 3).join("; ")}; and ${commits.length - 3} more`
    : commits.join("; ");

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
    const github = yield* GitHub.GitHub;

    // --- what a delete would lose ---

    // The branch's commits `head` never had, as `<short> <subject>`
    // lines: what deleting the branch would lose. A head this clone
    // lacks is fetched first; none when it still can't be read.
    const commitsBeyond = (
      repo: string,
      branch: string,
      head: string,
      remote: string,
    ) =>
      Effect.gen(function* () {
        if (!(yield* git.hasCommit(repo, head)) && remote !== "") {
          // Its failure is the check below's.
          yield* git
            .run(repo, ["fetch", "--quiet", "--no-tags", remote, head])
            .pipe(Effect.ignore);
        }
        if (!(yield* git.hasCommit(repo, head))) {
          return Option.none<ReadonlyArray<string>>();
        }
        const logged = yield* git.run(repo, [
          "log",
          "--format=%h %s",
          `${head}..refs/heads/${branch}`,
        ]);
        return Option.some(logged.split("\n").filter((line) => line !== ""));
      });

    // Whether the commits guard has a branch to keep: one a forced land
    // skips it for, a primary land's done deletes unless kept, and any
    // other's removal decides (Worktrees.deletesBranch).
    const deletesBranch = (
      worktree: Worktrees.WorktreeIdentity,
      options: RemoveOptions,
    ) =>
      options.force
        ? Effect.succeed(false)
        : worktree.isPrimary
          ? Effect.succeed(!options.keepBranch)
          : worktrees.deletesBranch(worktree, options.keepBranch);

    // Refuses the delete of `branch` when PR #`number`'s head, `head`,
    // lacks any of its commits, or can't be read to tell.
    const guardCommits = (
      repo: string,
      branch: string,
      number: number,
      head: string,
      remote: string,
      verb: LandingRefused["verb"],
    ) =>
      Effect.gen(function* () {
        const beyond = yield* commitsBeyond(repo, branch, head, remote);
        if (Option.isNone(beyond)) {
          return yield* refuse(
            verb,
            "head-unread",
            [number],
            [branch, head.slice(0, 7)],
          );
        }
        if (beyond.value.length > 0) {
          return yield* refuse(
            verb,
            "unpushed",
            [beyond.value.length, number],
            [branch, named(beyond.value)],
          );
        }
      });

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
    // the remote ref when needed), the branch it sat on deleted, then the
    // primary pulled current. The checkout frees the branch first: git
    // refuses to delete one that is out. The branch landed on is never
    // deleted. The pull comes last and doesn't fail it: by then the merge
    // is in and the branch gone, and a pull that failed (offline, a
    // primary that went its own way) is said beside them, where a
    // failure here once left the branch for good, since a land again
    // looks up the primary's PR and a done finds nothing to delete.
    const execDone = (
      project: RegisteredProject,
      target: Worktrees.PrimaryTarget,
      worktree: Worktrees.WorktreeIdentity,
      deleteBranch: boolean,
    ) =>
      Effect.gen(function* () {
        // The checkout and the delete run uninterrupted: an interrupt
        // between them would leave the branch for good, since a done
        // again from the primary branch finds nothing to delete.
        const deleted = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* git.checkoutBranch(
              worktree.path,
              target.primaryRef,
              target.remotes,
            );
            if (!deleteBranch || worktree.branch === target.primaryBranch) {
              return false;
            }
            yield* git.deleteBranch({
              repo: project.path,
              name: worktree.branch,
              force: true,
            });
            return true;
          }),
        );
        if (target.remote === "") return { deleted };
        const pulled = yield* ffPull(
          worktree.path,
          target.remote,
          target.primaryBranch,
        ).pipe(Effect.result);
        return Result.isFailure(pulled)
          ? { deleted, catchUpSkipped: errorDocument(pulled.failure).error }
          : { deleted };
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
          const { deleted, catchUpSkipped } = yield* execDone(
            project,
            target.success,
            worktree,
            !options.keepBranch,
          );
          const listed = yield* worktrees.identities(project);
          const row = yield* describeAfterDone(project, worktree, listed);
          // execDone pulled the primary branch, or says why it couldn't.
          // A PR into another line still leaves that line's checkout
          // behind.
          const skipped =
            catchUpSkipped === undefined ? undefined : { catchUpSkipped };
          const caught =
            base !== "" && base !== target.success.primaryBranch
              ? yield* catchUpBase(target.success, base, Effect.succeed(listed))
              : undefined;
          for (const said of [skipped, caught]) {
            if (said !== undefined && reporter.caughtUp !== undefined) {
              yield* reporter.caughtUp(said);
            }
          }
          // The base's catch-up as the document has it, and the primary's
          // skipped pull beside it.
          return doneDocument(row, worktree.branch, deleted, {
            ...extra,
            ...skipped,
            ...caught,
            ...(skipped !== undefined && caught !== undefined
              ? { catchUpSkipped }
              : {}),
          });
        }
        const caught: CatchUp = Result.isFailure(target)
          ? { catchUpSkipped: target.failure.message }
          : yield* catchUpBase(
              target.success,
              base,
              worktrees.identities(project),
            );
        if (reporter.caughtUp !== undefined) yield* reporter.caughtUp(caught);
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
      remote: string,
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
          const layer = chain.find((pr) => pr.headRefName === other.branch);
          if (layer !== undefined && (yield* deletesBranch(other, options))) {
            yield* guardCommits(
              located.project.path,
              other.branch,
              layer.number,
              yield* github.headOf(located.project.path, layer.number),
              remote,
              "land",
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
          if (reporter.removedOther !== undefined) {
            yield* reporter.removedOther(outcome.success);
          }
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
      deletesBranch,
      guardCommits,
      commitsBeyond,
      execDone,
      describeAfterDone,
      landCleanup,
      primaryTargetOf,
      planStackCleanup,
      execStackCleanup,
    };
  });

export type CleanupArea = Effect.Success<ReturnType<typeof makeCleanup>>;
