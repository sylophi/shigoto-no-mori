// Landing's pull requests: finding a worktree's, its checks and merge state, and the wait for a merge to go through.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Config from "../Config.ts";
import { mergeProblem, mergeWaitingOn } from "../mergeProgress.ts";
import * as GitHub from "../GitHub.ts";
import type { PullRequestSummary } from "../GitHub.ts";
import {
  autoMergeArms,
  pickMergeMethod,
  type MergeSettings,
} from "@shigomori/contracts/mergeMethods";
import type { MergeMethod } from "@shigomori/contracts/schemas/pullRequest";
import * as Paths from "../Paths.ts";
import type { RegisteredProject } from "../Registry.ts";
import {
  LandingRefused,
  MERGE_READ_ATTEMPTS,
  MERGE_STALL_POLLS,
  MergeLostTrack,
  MergeNeedsAttention,
  type MergeOutcome,
  MergePollInterval,
  type Reporter,
  projectScope,
} from "./documents.ts";

export const makePullRequests = Effect.gen(function* () {
  const github = yield* GitHub.GitHub;
  const config = yield* Config.Config;
  const binary = (yield* Paths.Paths).binaryName;

  const refuse = (
    verb: LandingRefused["verb"],
    reason: LandingRefused["reason"],
    numbers: ReadonlyArray<number> = [],
    names: ReadonlyArray<string> = [],
  ) =>
    new LandingRefused({
      verb,
      reason,
      numbers: [...numbers],
      names: [...names],
      binary,
    });

  // The explicit flag, else the project's last method while still
  // allowed, else the repo's first.
  const resolveMethod = (
    project: RegisteredProject,
    flag: MergeMethod | undefined,
    allowed: ReadonlyArray<MergeMethod>,
    verb: LandingRefused["verb"],
  ) =>
    Effect.gen(function* () {
      if (allowed.length === 0) return yield* refuse(verb, "no-methods");
      if (flag !== undefined) {
        if (!allowed.includes(flag)) {
          return yield* refuse(
            verb,
            "method-not-allowed",
            [],
            [flag, allowed.join(", ")],
          );
        }
        return flag;
      }
      const { settings } = Config.projectSettingsOf(
        yield* config.read(projectScope(project)),
      );
      return (
        pickMergeMethod(allowed, settings?.["lastMergeMethod"]) ??
        (yield* refuse(verb, "no-methods"))
      );
    });

  // Best effort, as the app does it.
  const persistMethod = (project: RegisteredProject, method: MergeMethod) =>
    config
      .set(projectScope(project), "lastMergeMethod", method)
      .pipe(Effect.ignore);

  // A stacked PR refuses the plain merge: only GitHub's own stack merge
  // lands it, and it lands every open PR under it too. So it is honoured
  // only for the lowest open PR of its stack. Any other failure is
  // reported as it came.
  const mergeStackedAlone = (
    repo: string,
    number: number,
    method: MergeMethod,
    failure: GitHub.GitHubCliError,
    verb: LandingRefused["verb"],
    reporter: Reporter,
  ) =>
    Effect.gen(function* () {
      if (!GitHub.stderrOf(failure).includes("part of a stack")) {
        return yield* failure;
      }
      const found = yield* github
        .stackFor(repo, number)
        .pipe(Effect.orElseSucceed(() => Option.none<GitHub.GitHubStack>()));
      if (Option.isNone(found)) return yield* failure;
      const lowest = found.value.find((entry) => entry.state === "open");
      if (lowest === undefined || lowest.number !== number) {
        return yield* refuse(verb, "stack-above", [number]);
      }
      return yield* mergeStackAsync(repo, number, method, reporter);
    });

  // GitHub's own stack merge. Answers whether a merge queue took the
  // stack instead of landing it, which is said as it happens.
  const mergeStackAsync = (
    repo: string,
    number: number,
    method: MergeMethod,
    reporter: Reporter,
  ) =>
    Effect.gen(function* () {
      const outcome = yield* github.mergeStackAsync(repo, number, method);
      if (outcome !== "enqueued") return false;
      if (reporter.waiting !== undefined) {
        yield* reporter.waiting(
          "the stack is in the merge queue; it lands when the queue processes it",
        );
      }
      return true;
    });

  // A merge gh accepted doesn't always end the way it was asked to:
  // --auto merges at once when the verdict has moved since the lookup,
  // and on a base branch with a merge queue either merge queues the PR.
  // So the outcome is read back off the PR rather than assumed. A read
  // that fails is never taken for a merge: the wait then reads the PR
  // until GitHub has merged it.
  const readBack = (repo: string, number: number, asked: MergeOutcome) =>
    github.mergeProgress(repo, number).pipe(
      Effect.map(
        (after): MergeOutcome =>
          after.state === "MERGED"
            ? { ...asked, outcome: "merged" }
            : after.isInMergeQueue
              ? { ...asked, outcome: "queued" }
              : after.autoMergeMethod !== undefined
                ? { ...asked, outcome: "auto-merge" }
                : asked,
      ),
      Effect.orElseSucceed(
        (): MergeOutcome =>
          asked.outcome === "merged" ? { ...asked, outcome: "queued" } : asked,
      ),
    );

  // Waits for a PR that didn't merge on the spot (auto-merge armed, or a
  // merge queue took it) until GitHub merges it. Every other way out is
  // an error naming what the PR needs, and the command to run again once
  // it's dealt with.
  const awaitMerge = (
    repo: string,
    pr: PullRequestSummary,
    o: MergeOutcome,
    verb: "merge" | "land",
    reporter: Reporter,
  ) =>
    Effect.gen(function* () {
      if (o.outcome === "merged") return;
      if (reporter.pending !== undefined) yield* reporter.pending(pr, o);
      const interval = yield* MergePollInterval;
      const command = `${binary} ${verb}`;
      let queued = o.outcome === "queued";
      let lastNote = "";
      let lastProblem = "";
      let failedReads = 0;
      let stalledPolls = 0;
      for (let first = true; ; first = false) {
        if (!first) yield* Effect.sleep(interval);
        const read = yield* Effect.result(
          github.mergeProgress(repo, pr.number),
        );
        if (Result.isFailure(read)) {
          failedReads++;
          if (failedReads === MERGE_READ_ATTEMPTS) {
            return yield* new MergeLostTrack({
              number: pr.number,
              command,
              cause: read.failure,
            });
          }
          continue;
        }
        failedReads = 0;
        const progress = read.success;
        if (progress.state === "MERGED") return;
        queued ||= progress.isInMergeQueue;
        let problem = mergeProblem(progress, pr.baseRefName, queued);
        const waitingOn = mergeWaitingOn(progress);
        if (
          problem === "" &&
          waitingOn === "" &&
          progress.mergeStateStatus === "BLOCKED"
        ) {
          stalledPolls++;
          if (stalledPolls >= MERGE_STALL_POLLS) {
            problem = "GitHub is holding it back for a reason sm can't see";
          }
        } else {
          stalledPolls = 0;
        }
        // A problem counts once two reads in a row see it: one read can
        // fall between two of GitHub's steps, like auto-merge handing the
        // PR to a merge queue, or the queue landing it.
        if (problem !== "" && problem === lastProblem) {
          return yield* new MergeNeedsAttention({
            number: pr.number,
            problem,
            url: pr.url,
            command,
          });
        }
        lastProblem = problem;
        if (problem !== "") continue;
        const line =
          waitingOn === ""
            ? "waiting for GitHub to merge it"
            : `waiting for GitHub to merge it: ${waitingOn}`;
        if (line !== lastNote) {
          lastNote = line;
          if (reporter.waiting !== undefined) yield* reporter.waiting(line);
        }
      }
    });

  // `gh pr merge`, with the stacked-PR fallback.
  const mergeNow = (
    repo: string,
    number: number,
    method: MergeMethod,
    verb: LandingRefused["verb"],
    reporter: Reporter,
  ) =>
    github.run(repo, ["pr", "merge", String(number), `--${method}`]).pipe(
      Effect.andThen(readBack(repo, number, { method, outcome: "merged" })),
      Effect.catchTags({
        GitHubCliError: (failure) =>
          mergeStackedAlone(repo, number, method, failure, verb, reporter).pipe(
            Effect.map(
              (queued): MergeOutcome => ({
                method,
                outcome: queued ? "queued" : "merged",
              }),
            ),
          ),
      }),
    );

  // The method picked, the PR landed as its verdict allows, the pick
  // kept for next time.
  const execMerge = (
    project: RegisteredProject,
    pr: PullRequestSummary,
    flag: MergeMethod | undefined,
    settings: MergeSettings,
    verb: LandingRefused["verb"],
    reporter: Reporter,
  ) =>
    Effect.gen(function* () {
      const method = yield* resolveMethod(
        project,
        flag,
        settings.allowed,
        verb,
      );
      let outcome: MergeOutcome;
      if (settings.autoMerge && autoMergeArms(pr.mergeStateStatus)) {
        const armed = pr.autoMergeRequest;
        if (armed !== undefined) {
          // GitHub refuses a second enable, and the PR lands on its own
          // with what is armed.
          outcome = {
            method:
              (armed.mergeMethod.toLowerCase() as MergeMethod | "") || method,
            outcome: "auto-merge",
            alreadyArmed: true,
          };
        } else {
          yield* github.run(project.path, [
            "pr",
            "merge",
            String(pr.number),
            "--auto",
            `--${method}`,
          ]);
          outcome = yield* readBack(project.path, pr.number, {
            method,
            outcome: "auto-merge",
          });
        }
      } else {
        outcome = yield* mergeNow(
          project.path,
          pr.number,
          method,
          verb,
          reporter,
        );
      }
      yield* persistMethod(project, method);
      return outcome;
    });

  // The PR lookup and the repo's settings are independent round trips.
  const mergeTarget = (
    repo: string,
    find: Effect.Effect<
      Option.Option<PullRequestSummary>,
      GitHub.GitHubCliError | GitHub.GitHubOutputError
    >,
  ) => Effect.all([find, github.mergeSettings(repo)], { concurrency: 2 });

  return {
    refuse,
    resolveMethod,
    persistMethod,
    awaitMerge,
    execMerge,
    mergeStackAsync,
    mergeTarget,
  };
});

export type PullRequestsArea = Effect.Success<typeof makePullRequests>;
