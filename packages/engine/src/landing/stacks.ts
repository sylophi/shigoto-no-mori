// Landing's stacks: the stacked pull requests a merge lands together, in order.
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { errorDocument } from "../errorDocument.ts";
import * as GitHub from "../GitHub.ts";
import type { MergeMethod, PullRequestSummary } from "../GitHub.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as Worktrees from "../Worktrees.ts";
import {
  LandingRefused,
  MAX_STACK_DEPTH,
  type Reporter,
  SETTLE_TIMEOUT_MS,
  mergedEvent,
  stackBelow,
} from "./documents.ts";
import type { PullRequestsArea } from "./pullRequests.ts";

export const makeStacks = ({
  pullRequests,
}: {
  readonly pullRequests: PullRequestsArea;
}) =>
  Effect.gen(function* () {
    const github = yield* GitHub.GitHub;
    const { refuse } = pullRequests;
    // --- stacks ---

    // What a stack's merge or cleanup reads first, at once: the trunk, the
    // page of PRs and, for a merge, GitHub's stack object. A failure is
    // reported in that order, whichever came back first.
    const lookupStack = (
      target: Effect.Effect<Worktrees.PrimaryTarget, LandingRefused>,
      project: RegisteredProject,
      number: number,
      withStack: boolean,
    ) =>
      Effect.gen(function* () {
        const read = yield* Effect.all(
          {
            target,
            prs: github.list(project.path),
            stack: withStack
              ? github.stackFor(project.path, number)
              : Effect.succeed(Option.none<GitHub.GitHubStack>()),
          },
          { concurrency: "unbounded", mode: "result" },
        );
        return {
          target: yield* Effect.fromResult(read.target),
          prs: yield* Effect.fromResult(read.prs),
          stack: yield* Effect.fromResult(read.stack),
        };
      });
    type StackLookups = Effect.Success<ReturnType<typeof lookupStack>>;

    // The full chain under `number`, bottom first, ending in it: the page's
    // rows, then the layers that fell off it, one lookup each, until the
    // base is the trunk or has no PR.
    const stackChain = (
      project: RegisteredProject,
      number: number,
      lookups: StackLookups,
      verb: LandingRefused["verb"],
    ) =>
      Effect.gen(function* () {
        const trunk = lookups.target.primaryBranch;
        let chain = stackBelow(lookups.prs, number, trunk);
        if (chain === undefined) {
          const own = yield* github.findByNumber(project.path, number);
          if (Option.isNone(own)) {
            return yield* refuse(verb, "no-such-number", [number]);
          }
          chain = [own.value];
        }
        // Asked for by number, so it could be a stranger's fork PR. The
        // layers under it never are.
        const top = chain[chain.length - 1] as PullRequestSummary;
        if (
          top.isCrossRepository === true &&
          !(yield* github.checkedOutFrom(project.path, top.headRefName, number))
        ) {
          return yield* refuse(verb, "fork", [number]);
        }
        while (chain.length < MAX_STACK_DEPTH) {
          const base: string = (chain[0] as PullRequestSummary).baseRefName;
          if (base === trunk) break;
          const below: Option.Option<PullRequestSummary> = yield* github.find(
            project.path,
            base,
          );
          if (Option.isNone(below)) break;
          chain = [below.value, ...chain];
        }
        return chain;
      });

    // The PRs a stack merge lands, bottom first: the open ones. A closed PR
    // under an open one breaks the stack, and a draft isn't mergeable.
    const stackMergeSet = (
      chain: ReadonlyArray<PullRequestSummary>,
      verb: LandingRefused["verb"],
    ) =>
      Effect.gen(function* () {
        const set: PullRequestSummary[] = [];
        for (const pr of chain) {
          if (pr.state === "CLOSED") {
            return yield* refuse(
              verb,
              "stack-closed",
              [pr.number],
              [pr.headRefName],
            );
          }
          if (pr.state === "OPEN") {
            if (pr.isDraft) {
              return yield* refuse(
                verb,
                "stack-draft",
                [pr.number],
                [pr.headRefName],
              );
            }
            set.push(pr);
          }
        }
        if (set.length === 0) return yield* refuse(verb, "stack-all-merged");
        return set;
      });

    // A resolved set landed the way the stack allows: GitHub's own merge
    // when it knows the stack, one PR at a time otherwise, each above the
    // bottom retargeted at the trunk first. Answers whether a merge queue
    // took the stack instead of landing it.
    const mergeStackSet = (
      project: RegisteredProject,
      number: number,
      method: MergeMethod,
      lookups: StackLookups,
      chain: ReadonlyArray<PullRequestSummary>,
      set: ReadonlyArray<PullRequestSummary>,
      verb: LandingRefused["verb"],
      reporter: Reporter,
    ) =>
      Effect.gen(function* () {
        const report = (pr: PullRequestSummary) =>
          reporter.merged?.(mergedEvent(pr, method), pr) ?? Effect.void;
        if (Option.isSome(lookups.stack)) {
          const outcome = yield* github.mergeStackAsync(
            project.path,
            number,
            method,
          );
          if (outcome === "enqueued") return true;
          for (const pr of set) yield* report(pr);
          return false;
        }
        const trunk = (chain[0] as PullRequestSummary).baseRefName;
        const landed: PullRequestSummary[] = [];
        for (const pr of set) {
          const step = Effect.gen(function* () {
            if (pr.baseRefName !== trunk) {
              yield* github.run(project.path, [
                "pr",
                "edit",
                String(pr.number),
                "--base",
                trunk,
              ]);
              yield* settleMergeability(project.path, pr.number);
            }
            yield* github.run(project.path, [
              "pr",
              "merge",
              String(pr.number),
              `--${method}`,
            ]);
          });
          const outcome = yield* Effect.result(step);
          if (Result.isFailure(outcome)) {
            return yield* refuse(
              verb,
              "stack-step",
              [pr.number],
              [
                landed.map((done) => `#${done.number}`).join(", "),
                errorDocument(outcome.failure).error,
              ],
            );
          }
          landed.push(pr);
          yield* report(pr);
        }
        return false;
      });

    // GitHub recomputes a PR's mergeability after a retarget, and merging
    // in that window fails with a bare "not mergeable". Waits for the
    // verdict, a second apart for twenty seconds at most: the merge itself
    // is the real check.
    const settleMergeability = (repo: string, number: number) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + SETTLE_TIMEOUT_MS;
        while ((yield* Clock.currentTimeMillis) < deadline) {
          const verdict = yield* github
            .mergeStateStatus(repo, number)
            .pipe(Effect.option);
          if (Option.isNone(verdict)) return;
          if (verdict.value !== "UNKNOWN" && verdict.value !== "") return;
          yield* Effect.sleep(Duration.seconds(1));
        }
      });

    return { lookupStack, stackChain, stackMergeSet, mergeStackSet };
  });

export type StacksArea = Effect.Success<ReturnType<typeof makeStacks>>;
