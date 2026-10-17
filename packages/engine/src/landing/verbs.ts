// Landing's verbs: pr, merge, land, done and a stack's removal.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Git from "../Git.ts";
import * as GitHub from "../GitHub.ts";
import type { MergeMethod, PullRequestSummary } from "../GitHub.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as Worktrees from "../Worktrees.ts";
import {
  LandingRefused,
  MERGE_FIELDS,
  MergeUnverified,
  type RemoveOptions,
  type Reporter,
  doneDocument,
  mergeDocument,
  mergeResultFields,
  outcomeFields,
} from "./documents.ts";
import type { PullRequestsArea } from "./pullRequests.ts";
import type { StacksArea } from "./stacks.ts";
import type { CleanupArea } from "./cleanup.ts";

export const makeVerbs = ({
  pullRequests,
  stacks,
  cleanup,
}: {
  readonly pullRequests: PullRequestsArea;
  readonly stacks: StacksArea;
  readonly cleanup: CleanupArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const github = yield* GitHub.GitHub;
    const worktrees = yield* Worktrees.Worktrees;
    const {
      refuse,
      resolveMethod,
      persistMethod,
      awaitMerge,
      execMerge,
      mergeTarget,
    } = pullRequests;
    const { lookupStack, stackChain, stackMergeSet, mergeStackSet } = stacks;
    const {
      deletesBranch,
      guardCommits,
      commitsBeyond,
      execDone,
      describeAfterDone,
      landCleanup,
      primaryTargetOf,
      planStackCleanup,
      execStackCleanup,
    } = cleanup;
    const branchOf = (
      located: Worktrees.Located,
      verb: LandingRefused["verb"],
    ) =>
      located.worktree.detached ||
      located.worktree.branch === Worktrees.UNKNOWN_BRANCH
        ? Effect.fail(refuse(verb, "no-branch"))
        : Effect.succeed(located.worktree.branch);

    const pullRequest = Effect.fn("Landing.pullRequest")(function* (
      located: Worktrees.Located,
    ) {
      const branch = yield* branchOf(located, "pr");
      const found = yield* github.find(located.project.path, branch);
      if (Option.isNone(found)) {
        return yield* refuse("pr", "no-pull-request", [], [branch]);
      }
      const pr = found.value;
      return {
        ok: true,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
        branch,
        url: pr.url,
      };
    });

    // The repo's methods are read beside the stack when not already known.
    const mergeStack = (
      project: RegisteredProject,
      number: number,
      flag: MergeMethod | undefined,
      known: ReadonlyArray<MergeMethod> | undefined,
      reporter: Reporter,
    ) =>
      Effect.gen(function* () {
        const [lookups, allowed] = yield* Effect.all(
          [
            lookupStack(
              primaryTargetOf(project, "merge"),
              project,
              number,
              true,
            ),
            known === undefined
              ? Effect.map(github.mergeSettings(project.path), (s) => s.allowed)
              : Effect.succeed(known),
          ],
          { concurrency: 2 },
        );
        const method = yield* resolveMethod(project, flag, allowed, "merge");
        const chain = yield* stackChain(project, number, lookups, "merge");
        const set = yield* stackMergeSet(chain, "merge");
        const queued = yield* mergeStackSet(
          project,
          number,
          method,
          lookups,
          chain,
          set,
          "merge",
          reporter,
        );
        yield* persistMethod(project, method);
        // A stack a merge queue took (or one layer of it) is still open:
        // the app reads a document with no outcome as merged.
        return queued
          ? { ok: true, method, outcome: "queued" as const }
          : { ok: true, method };
      });

    const merge = Effect.fn("Landing.merge")(function* (
      target:
        | { readonly located: Worktrees.Located }
        | { readonly project: RegisteredProject; readonly number: number },
      options: {
        readonly method?: MergeMethod | undefined;
        readonly stack: boolean;
      },
      reporter: Reporter,
    ) {
      if ("number" in target) {
        const { project, number } = target;
        if (options.stack) {
          return yield* mergeStack(
            project,
            number,
            options.method,
            undefined,
            reporter,
          );
        }
        const [found, settings] = yield* mergeTarget(
          project.path,
          github.findByNumber(project.path, number, MERGE_FIELDS),
        );
        if (Option.isNone(found)) {
          return yield* refuse("merge", "no-such-number", [number]);
        }
        const pr = found.value;
        if (
          pr.isCrossRepository === true &&
          !(yield* github.checkedOutFrom(project.path, pr.headRefName, number))
        ) {
          return yield* refuse("merge", "fork", [number]);
        }
        if (pr.state !== "OPEN") {
          return yield* refuse(
            "merge",
            "not-open",
            [number],
            ["", pr.state.toLowerCase()],
          );
        }
        const outcome = yield* execMerge(
          project,
          pr,
          options.method,
          settings,
          "merge",
          reporter,
        );
        if (reporter.outcome !== undefined) {
          yield* reporter.outcome(pr, outcome);
        }
        return {
          ok: true,
          number,
          method: outcome.method,
          ...outcomeFields(outcome),
        };
      }
      const { located } = target;
      const branch = yield* branchOf(located, "merge");
      const [found, settings] = yield* mergeTarget(
        located.project.path,
        github.find(located.project.path, branch, MERGE_FIELDS),
      );
      if (Option.isNone(found)) {
        return yield* refuse("merge", "no-pull-request", [], [branch]);
      }
      const pr = found.value;
      if (pr.state !== "OPEN") {
        return yield* refuse(
          "merge",
          "not-open",
          [pr.number],
          [branch, pr.state.toLowerCase()],
        );
      }
      if (options.stack) {
        return yield* mergeStack(
          located.project,
          pr.number,
          options.method,
          settings.allowed,
          reporter,
        );
      }
      const outcome = yield* execMerge(
        located.project,
        pr,
        options.method,
        settings,
        "merge",
        reporter,
      );
      yield* awaitMerge(located.project.path, pr, outcome, "merge", reporter);
      return mergeDocument(pr, branch, { ...outcome, outcome: "merged" });
    });

    const land = Effect.fn("Landing.land")(function* (
      located: Worktrees.Located,
      options: RemoveOptions & {
        readonly method?: MergeMethod | undefined;
        readonly stack: boolean;
      },
      reporter: Reporter,
    ) {
      const { project, worktree } = located;
      const branch = yield* branchOf(located, "land");
      // The removal guards before the remote is touched: uncommitted work
      // wouldn't be in the PR being merged.
      if (!worktree.isPrimary) {
        yield* worktrees.checkRemovable(located, options.force);
      }
      // The primary target is read beside the PR's lookups, for the stack's
      // trunk or the plain land's guard and cleanup. Its failure only skips
      // those two, and a stack land reports it after the PR's own refusals.
      const [[found, settings], target] = yield* Effect.all(
        [
          mergeTarget(
            project.path,
            github.find(project.path, branch, MERGE_FIELDS),
          ),
          primaryTargetOf(project, "land").pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      if (Option.isNone(found)) {
        return yield* refuse("land", "no-pull-request", [], [branch]);
      }
      const pr = found.value;
      if (pr.state !== "OPEN" && pr.state !== "MERGED") {
        return yield* refuse(
          "land",
          "not-open",
          [pr.number],
          [branch, pr.state.toLowerCase(), worktree.name],
        );
      }
      // The branch goes with the land (unless kept): it may hold commits
      // the PR never had, made after its last push, or under a name an
      // older PR merged with.
      const remote = Result.isSuccess(target) ? target.success.remote : "";
      const guarded = yield* deletesBranch(worktree, options);
      if (guarded) {
        yield* guardCommits(
          project.path,
          branch,
          pr.number,
          yield* github.headOf(project.path, pr.number),
          remote,
          "land",
        );
      }
      if (options.stack) {
        const lookups = yield* lookupStack(
          Effect.fromResult(target),
          project,
          pr.number,
          pr.state === "OPEN",
        );
        const chain = yield* stackChain(project, pr.number, lookups, "land");
        let set: ReadonlyArray<PullRequestSummary> = [];
        let method: MergeMethod | undefined;
        if (pr.state === "OPEN") {
          set = yield* stackMergeSet(chain, "land");
          method = yield* resolveMethod(
            project,
            options.method,
            settings.allowed,
            "land",
          );
        }
        const planCleanup = planStackCleanup(
          located,
          chain,
          set,
          options,
          lookups.target.remote,
        );
        let plan = yield* planCleanup;
        if (method !== undefined) {
          const queued = yield* mergeStackSet(
            project,
            pr.number,
            method,
            lookups,
            chain,
            set,
            "land",
            reporter,
          );
          yield* persistMethod(project, method);
          if (queued) {
            return mergeDocument(pr, branch, { method, outcome: "queued" });
          }
          // The merge can wait minutes on GitHub, time enough for new work
          // in any of the worktrees, so the guards run again, on the heads
          // the PRs merged with, this worktree's own removal guard first,
          // as a single land's.
          if (!worktree.isPrimary) {
            yield* worktrees.checkRemovable(located, options.force);
          }
          if (guarded) {
            yield* guardCommits(
              project.path,
              branch,
              pr.number,
              yield* github.headOf(project.path, pr.number),
              remote,
              "land",
            );
          }
          plan = yield* planCleanup;
        } else if (reporter.landing !== undefined) {
          yield* reporter.landing(pr, undefined);
        }
        return yield* execStackCleanup(
          located,
          pr,
          true,
          chain,
          plan,
          lookups.target,
          options,
          { merged: mergeResultFields(pr, branch, method) },
          reporter,
        );
      }

      let method: MergeMethod | undefined;
      if (pr.state === "OPEN") {
        // A PR on another open PR, merged alone, would fold into the layer
        // below, and land would then remove the worktree as if it landed.
        if (
          Result.isSuccess(target) &&
          pr.baseRefName !== "" &&
          pr.baseRefName !== target.success.primaryBranch
        ) {
          const below = yield* github.find(project.path, pr.baseRefName);
          if (Option.isSome(below) && below.value.state === "OPEN") {
            return yield* refuse(
              "land",
              "stacked",
              [pr.number, below.value.number],
              [branch, below.value.headRefName, worktree.name],
            );
          }
        }
        const outcome = yield* execMerge(
          project,
          pr,
          options.method,
          settings,
          "land",
          reporter,
        );
        yield* awaitMerge(project.path, pr, outcome, "land", reporter);
        // The wait can take as long as the checks do, time enough for new
        // work in the worktree, so the guards run again, on the head the
        // PR merged with.
        if (outcome.outcome !== "merged") {
          if (!worktree.isPrimary) {
            yield* worktrees.checkRemovable(located, options.force);
          }
          if (guarded) {
            yield* guardCommits(
              project.path,
              branch,
              pr.number,
              yield* github.headOf(project.path, pr.number),
              remote,
              "land",
            );
          }
        }
        method = outcome.method;
      }
      if (reporter.landing !== undefined) yield* reporter.landing(pr, method);
      return yield* landCleanup(
        located,
        pr.baseRefName,
        target,
        options,
        { merged: mergeResultFields(pr, branch, method) },
        reporter,
      );
    });

    const removeStack = Effect.fn("Landing.removeStack")(function* (
      located: Worktrees.Located,
      options: RemoveOptions,
      reporter: Reporter,
    ) {
      const { project } = located;
      const branch = yield* branchOf(located, "rm");
      yield* worktrees.checkRemovable(located, options.force);
      const found = yield* github.find(project.path, branch);
      if (Option.isNone(found)) {
        return yield* refuse("rm", "no-pull-request", [], [branch]);
      }
      const pr = found.value;
      if (pr.state === "OPEN") {
        return yield* refuse("rm", "stack-still-open", [pr.number], [branch]);
      }
      // Nothing merges, so no GitHub stack object.
      const lookups = yield* lookupStack(
        primaryTargetOf(project, "rm"),
        project,
        pr.number,
        false,
      );
      const chain = yield* stackChain(project, pr.number, lookups, "rm");
      if (yield* deletesBranch(located.worktree, options)) {
        yield* guardCommits(
          project.path,
          branch,
          pr.number,
          yield* github.headOf(project.path, pr.number),
          lookups.target.remote,
          "rm",
        );
      }
      const plan = yield* planStackCleanup(
        located,
        chain,
        [],
        options,
        lookups.target.remote,
      );
      return yield* execStackCleanup(
        located,
        pr,
        pr.state === "MERGED",
        chain,
        plan,
        lookups.target,
        options,
        {},
        reporter,
      );
    });

    const done = Effect.fn("Landing.done")(function* (
      located: Worktrees.Located,
      options: { readonly force: boolean },
    ) {
      const { project, worktree } = located;
      const branch = yield* branchOf(located, "done");
      const target = yield* primaryTargetOf(project, "done");
      // The delete is `branch -D`, so it needs proof the branch is merged:
      // an ancestor of the primary ref, or held whole by the head of a
      // merged PR (a squash merge leaves no ancestry, and the branch may
      // have moved on since, or reuse an older PR's name).
      if (
        branch !== target.primaryBranch &&
        !options.force &&
        !(yield* git
          .isAncestor(project.path, branch, target.primaryRef)
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        const heads = yield* github
          .mergedHeads(project.path, branch)
          .pipe(
            Effect.mapError((cause) => new MergeUnverified({ branch, cause })),
          );
        if (heads.length === 0) {
          return yield* refuse(
            "done",
            "not-merged",
            [],
            [branch, target.primaryRef],
          );
        }
        let held = false;
        for (const { head } of heads) {
          const beyond = yield* commitsBeyond(
            project.path,
            branch,
            head,
            target.remote,
          );
          if (Option.isSome(beyond) && beyond.value.length === 0) held = true;
          if (held) break;
        }
        if (!held) {
          // The newest merged PR's verdict says what is missing.
          const [newest] = heads;
          if (newest !== undefined) {
            yield* guardCommits(
              project.path,
              branch,
              newest.number,
              newest.head,
              target.remote,
              "done",
            );
          }
        }
      }
      const { deleted, catchUpSkipped } = yield* execDone(
        project,
        target,
        worktree,
        true,
      );
      const row = yield* describeAfterDone(
        project,
        worktree,
        yield* worktrees.identities(project),
      );
      return doneDocument(
        row,
        branch,
        deleted,
        catchUpSkipped === undefined ? {} : { catchUpSkipped },
      );
    });

    return { pullRequest, merge, land, removeStack, done };
  });
