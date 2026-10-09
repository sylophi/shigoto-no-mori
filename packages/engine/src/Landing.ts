// The finish line: a worktree's pull request merged on GitHub, its
// branch's checkout caught up, and the worktree cleaned up. One merge
// flow under `merge`, `land` and the app's merge button: the merge
// method picked (the flag, the project's last one, the repo's first),
// auto-merge armed where the base branch's rules aren't met yet, a stack
// landed whole. `done` lands a checkout back on the primary branch.
// Answers are the documents `sm --json` prints, and each step reported
// along the way is too.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Config from "./Config.ts";
import { mergeProblem, mergeWaitingOn } from "./mergeProgress.ts";
import { errorDocument } from "./errorDocument.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import type {
  MergeMethod,
  MergeSettings,
  PullRequestSummary,
} from "./GitHub.ts";
import * as Paths from "./Paths.ts";
import type { RegisteredProject } from "./Registry.ts";
import * as Worktrees from "./Worktrees.ts";

// A document `sm --json` prints.
export type Document = Readonly<Record<string, unknown>>;

// What landing won't do, the reason in its message. `numbers` and
// `names` are the PRs, branches and paths the message names, in order.
export class LandingRefused extends Schema.TaggedError<LandingRefused>()(
  "LandingRefused",
  {
    reason: Schema.Literals([
      "no-branch",
      "no-pull-request",
      "not-open",
      "no-such-number",
      "fork",
      "stacked",
      "stack-still-open",
      "no-methods",
      "method-not-allowed",
      "stack-closed",
      "stack-draft",
      "stack-all-merged",
      "stack-above",
      "stack-step",
      "no-primary",
      "not-merged",
      "not-on-branch",
      "vanished",
      "guard",
    ]),
    // Which verb refused, where the wording differs by verb.
    verb: Schema.Literals(["land", "merge", "done", "pr", "rm"]),
    numbers: Schema.Array(Schema.Int),
    names: Schema.Array(Schema.String),
    binary: Schema.String,
  },
) {
  override get message(): string {
    const [n0 = 0, n1 = 0] = this.numbers;
    const [a = "", b = "", c = "", d = ""] = this.names;
    const bin = this.binary;
    switch (this.reason) {
      case "no-branch":
        return this.verb === "land"
          ? "No branch checked out to land"
          : this.verb === "merge"
            ? "No branch checked out to merge"
            : this.verb === "done"
              ? "No branch checked out to clean up"
              : this.verb === "pr"
                ? "No branch checked out to look up"
                : "No branch checked out";
      case "no-pull-request":
        return this.verb === "land"
          ? `No pull request found for branch ${a}. Push the branch and open a PR first`
          : this.verb === "rm"
            ? `No pull request found for branch ${a}, so no stack to clean up`
            : `No pull request found for branch ${a}`;
      case "not-open":
        return this.verb === "land"
          ? `PR #${n0} for ${a} is ${b}, not open. Reopen it, or clean up with \`${bin} rm ${c}\``
          : a === ""
            ? `PR #${n0} is ${b}, not open`
            : `PR #${n0} for ${a} is ${b}, not open`;
      case "no-such-number":
        return `No pull request #${n0}`;
      case "fork":
        return `PR #${n0} is from a fork, and its branch here wasn't checked out from it. Merge it on GitHub instead.`;
      case "stacked":
        return `PR #${n0} (${a}) is stacked on open PR #${n1} (${b}). \`${bin} land --stack\` lands both. to merge it into ${b} alone, \`${bin} merge\` then \`${bin} rm ${c}\``;
      case "stack-still-open":
        return `PR #${n0} for ${a} is still open. \`${bin} land --stack\` lands it`;
      case "no-methods":
        return "The repo's settings allow no merge method";
      case "method-not-allowed":
        return `The repo's settings don't allow ${a} merges (allowed: ${b})`;
      case "stack-closed":
        return `PR #${n0} (${a}) under the stack is closed without merging; reopen or rebase past it first`;
      case "stack-draft":
        return `PR #${n0} (${a}) in the stack is a draft; mark it ready first`;
      case "stack-all-merged":
        return "Every PR in the stack is already merged";
      case "stack-above":
        return `PR #${n0} sits above open pull requests in its GitHub stack. Merge the stack instead (\`${bin} merge --stack\` or \`${bin} land --stack\`)`;
      case "stack-step":
        // `a` lists what landed before the step that failed, and `b` is
        // what failed it.
        return a === ""
          ? `PR #${n0}: ${b}`
          : `merged ${a}, then PR #${n0} failed: ${b}`;
      case "no-primary":
        return `No local branches found in ${a}`;
      case "not-merged":
        return `Branch ${a} isn't merged into ${b} (no merge found, no merged PR). Merge it first, or pass --force to discard it.`;
      case "not-on-branch":
        return `${a} is on ${b}, not ${c}`;
      case "vanished":
        return "worktree disappeared after switching branches";
      case "guard":
        // A worktree a stack land would remove refused the removal.
        return `worktree ${a} (${b}): ${c}${d}`;
    }
  }
}

// A PR merge and land waited on that GitHub won't merge without a
// person: `problem` says why.
export class MergeNeedsAttention extends Schema.TaggedError<MergeNeedsAttention>()(
  "MergeNeedsAttention",
  {
    number: Schema.Int,
    problem: Schema.String,
    url: Schema.String,
    command: Schema.String,
  },
) {
  get documentCode(): string {
    return "needs-attention";
  }

  override get message(): string {
    return `PR #${this.number} needs attention: ${this.problem} (${this.url}). Run \`${this.command}\` again once it's dealt with`;
  }
}

// The wait couldn't read the PR, several times in a row.
export class MergeLostTrack extends Schema.TaggedError<MergeLostTrack>()(
  "MergeLostTrack",
  {
    number: Schema.Int,
    command: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Lost track of PR #${this.number}: ${errorDocument(this.cause).error}. Run \`${this.command}\` again to keep waiting`;
  }
}

// How a merge ended, in the app's spelling: it landed, a merge queue took
// it, or auto-merge is armed and GitHub lands it once its requirements
// are met. The last two leave the PR open, and merge and land wait on
// them (awaitMerge).
type Outcome = "merged" | "queued" | "auto-merge";

export type MergeOutcome = {
  readonly method: MergeMethod;
  readonly outcome: Outcome;
  // An auto-merge armed before this merge, which it left as it was.
  readonly alreadyArmed?: boolean;
};

// How long the wait for GitHub to merge sleeps between reads.
export const MergePollInterval = Context.Reference<Duration.Duration>(
  "sm/engine/Landing/MergePollInterval",
  { defaultValue: () => Duration.seconds(10) },
);

// A read that fails this many times in a row ends the wait. One that
// fails now and then (a network blip) is waited out.
const MERGE_READ_ATTEMPTS = 5;

// How many polls in a row (about five minutes) a PR may sit BLOCKED
// with nothing the wait can see to wait on before it counts as stuck: a
// required check that never reports, say, or a rule the reads don't
// cover.
const MERGE_STALL_POLLS = 30;

// Where a land's steps go: the merged layers of a stack, the scripts of
// a removal.
export type Reporter = Worktrees.Reporter & {
  // A layer of a stack merged: its document, and the PR, whose title a
  // person's line names.
  readonly merged?: (
    event: Document,
    pr: PullRequestSummary,
  ) => Effect.Effect<void>;
  // The PR a merge by number is about to merge, whose title the
  // document leaves out and a person's line names.
  readonly target?: (pr: PullRequestSummary) => Effect.Effect<void>;
  // A PR that didn't merge on the spot, which the command now waits on
  // until GitHub merges it, and each change in what it waits on.
  readonly pending?: (
    pr: PullRequestSummary,
    outcome: MergeOutcome,
  ) => Effect.Effect<void>;
  readonly waiting?: (line: string) => Effect.Effect<void>;
  // A word for a person beside the document: a stack land that leaves
  // the primary checkout on a landed branch says how it gets back.
  readonly note?: (line: string) => Effect.Effect<void>;
};

// What each verb can fail with. A stack land is the cleanup of
// `rm --stack` after the merge of `merge --stack`.
type MergeError =
  | LandingRefused
  | GitHub.GitHubCliError
  | GitHub.GitHubOutputError
  | GitHub.StackMergeFailed
  | MergeNeedsAttention
  | MergeLostTrack;
type DoneError = LandingRefused | Git.GitError | Git.BranchNotMergedError;
type RemoveStackError =
  | DoneError
  | GitHub.GitHubCliError
  | GitHub.GitHubOutputError
  | Worktrees.WorktreeRefused
  | Worktrees.DirtyWorktree;
type LandError =
  | RemoveStackError
  | GitHub.StackMergeFailed
  | MergeNeedsAttention
  | MergeLostTrack;

type RemoveOptions = {
  readonly force: boolean;
  readonly keepBranch: boolean;
  readonly skipCleanup: boolean;
};

export class Landing extends Context.Service<
  Landing,
  {
    // `sm pr`: the worktree's pull request, any state.
    readonly pullRequest: (
      located: Worktrees.Located,
    ) => Effect.Effect<
      Document,
      LandingRefused | GitHub.GitHubCliError | GitHub.GitHubOutputError
    >;
    // `sm merge`: the worktree's open PR, or with `number` that PR of the
    // project, merged (or queued, or auto-merge armed). A PR that didn't
    // merge on the spot is waited on until GitHub merges it, except by
    // `number` (the app's merge, which shows the armed or queued PR
    // itself). `stack` merges every open PR under it too, bottom first,
    // each reported.
    readonly merge: (
      target:
        | { readonly located: Worktrees.Located }
        | { readonly project: RegisteredProject; readonly number: number },
      options: {
        readonly method?: MergeMethod | undefined;
        readonly stack: boolean;
      },
      reporter: Reporter,
    ) => Effect.Effect<Document, MergeError>;
    // `sm land`: merge, catch the base branch's checkout up, clean up.
    readonly land: (
      located: Worktrees.Located,
      options: RemoveOptions & {
        readonly method?: MergeMethod | undefined;
        readonly stack: boolean;
      },
      reporter: Reporter,
    ) => Effect.Effect<Document, LandError>;
    // `sm rm --stack`: the cleanup half of a stack land, for one that
    // has landed.
    readonly removeStack: (
      located: Worktrees.Located,
      options: RemoveOptions,
      reporter: Reporter,
    ) => Effect.Effect<Document, RemoveStackError>;
    // `sm done`: the checkout back on the primary branch, the merged
    // branch it was on deleted.
    readonly done: (
      located: Worktrees.Located,
      options: { readonly force: boolean },
    ) => Effect.Effect<Document, DoneError>;
  }
>()("sm/engine/Landing") {}

// The fields a merge verdict needs, which only the merge paths ask for.
const MERGE_FIELDS = ["mergeStateStatus", "autoMergeRequest"];

const SETTLE_TIMEOUT_MS = 20 * 1000;

// Bounds the walk down a chain: the rows are a snapshot, so a loop in
// stale ones must end.
const MAX_STACK_DEPTH = 64;

// The verdicts auto-merge is for: the base branch's rules aren't met yet,
// or the head must catch up with a base that requires it. Anything else
// merges now, or keeps the plain merge's refusal.
const autoMergeArms = (status: string | undefined) =>
  status === "BLOCKED" || status === "BEHIND";

// The merge's fields in merge's document and land's "merged". No method
// means the PR was merged before the command ran.
const mergeResultFields = (
  pr: PullRequestSummary,
  branch: string,
  method: MergeMethod | undefined,
): Record<string, unknown> => ({
  number: pr.number,
  title: pr.title,
  branch,
  url: pr.url,
  ...(method === undefined ? { alreadyMerged: true } : { method }),
});

const outcomeFields = (o: MergeOutcome) => ({
  outcome: o.outcome,
  queued: o.outcome === "queued",
});

// The document of a merge that went through, landed or not.
const mergeDocument = (
  pr: PullRequestSummary,
  branch: string,
  o: MergeOutcome,
): Document => ({
  ...mergeResultFields(pr, branch, o.method),
  ok: true,
  ...outcomeFields(o),
});

// The chain from the bottom of the stack up to `number`, or just that PR
// when nothing sits under it: a PR whose base is another PR's head is
// stacked on it. The newest PR wins a reused head branch, and a fork's
// PR never does. The trunk is never a member.
function stackBelow(
  prs: ReadonlyArray<PullRequestSummary>,
  number: number,
  trunk: string,
): PullRequestSummary[] | undefined {
  const byHead = new Map<string, PullRequestSummary>();
  let own: PullRequestSummary | undefined;
  for (const pr of prs) {
    if (!byHead.has(pr.headRefName) && pr.isCrossRepository !== true) {
      byHead.set(pr.headRefName, pr);
    }
    if (pr.number === number && own === undefined) own = pr;
  }
  if (own === undefined) return undefined;
  const chain = [own];
  const visited = new Set([own.headRefName]);
  let cursor = own;
  while (chain.length < MAX_STACK_DEPTH) {
    const parent = byHead.get(cursor.baseRefName);
    if (
      parent === undefined ||
      cursor.baseRefName === trunk ||
      visited.has(parent.headRefName)
    ) {
      break;
    }
    visited.add(parent.headRefName);
    chain.push(parent);
    cursor = parent;
  }
  return chain.toReversed();
}

const projectScope = (project: RegisteredProject) =>
  ({ kind: "project", projectId: project.id, path: project.path }) as const;

const mergedEvent = (pr: PullRequestSummary, method: MergeMethod) => ({
  event: "merged",
  number: pr.number,
  branch: pr.headRefName,
  method,
});

const doneDocument = (
  row: Worktrees.WorktreeRow,
  branch: string,
  deleted: boolean,
  extra: Record<string, unknown>,
): Document => ({
  ok: true,
  worktree: row,
  deletedBranch: deleted ? branch : null,
  ...extra,
});

// A cleanup failure after the merge: the document keeps the merge's
// fields, since one without them would read as nothing changed.
const cleanupFailed = (
  error: unknown,
  extra: Record<string, unknown>,
): Document =>
  error instanceof Worktrees.CleanupFailed
    ? {
        ...extra,
        ok: false,
        cleanupError: Worktrees.cleanupErrorOf(error),
      }
    : { ...extra, ok: false, ...errorDocument(error) };

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const github = yield* GitHub.GitHub;
  const worktrees = yield* Worktrees.Worktrees;
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
      const [first] = allowed;
      if (first === undefined) return yield* refuse(verb, "no-methods");
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
      const last = settings?.["lastMergeMethod"];
      return allowed.find((method) => method === last) ?? first;
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
      return (
        (yield* github.mergeStackAsync(repo, number, method)) === "enqueued"
      );
    });

  // A merge gh accepted doesn't always end the way it was asked to:
  // --auto merges at once when the verdict has moved since the lookup,
  // and on a base branch with a merge queue either merge queues the PR.
  // So the outcome is read back off the PR rather than assumed. A read
  // that fails leaves the one asked for, since it only shapes the report
  // and the wait.
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
      Effect.orElseSucceed(() => asked),
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
  ) =>
    github.run(repo, ["pr", "merge", String(number), `--${method}`]).pipe(
      Effect.andThen(readBack(repo, number, { method, outcome: "merged" })),
      Effect.catchTags({
        GitHubCliError: (failure) =>
          mergeStackedAlone(repo, number, method, failure, verb).pipe(
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
        outcome = yield* mergeNow(project.path, pr.number, method, verb);
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
    worktrees
      .primaryTarget(project)
      .pipe(
        Effect.flatMap((target) =>
          target.primaryRef === ""
            ? Effect.fail(refuse(verb, "no-primary", [], [project.path]))
            : Effect.succeed(target),
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
        : listed.find((other) => other.isPrimary && landing.has(other.branch));
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

  // --- the verbs ---

  const branchOf = (located: Worktrees.Located, verb: LandingRefused["verb"]) =>
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
          lookupStack(primaryTargetOf(project, "merge"), project, number, true),
          known === undefined
            ? Effect.map(github.mergeSettings(project.path), (s) => s.allowed)
            : Effect.succeed(known),
        ],
        { concurrency: 2 },
      );
      const method = yield* resolveMethod(project, flag, allowed, "merge");
      const chain = yield* stackChain(project, number, lookups, "merge");
      const set = yield* stackMergeSet(chain, "merge");
      yield* mergeStackSet(
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
      return { ok: true, method };
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
      if (reporter.target !== undefined) yield* reporter.target(pr);
      const outcome = yield* execMerge(
        project,
        pr,
        options.method,
        settings,
        "merge",
      );
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
      const plan = yield* planStackCleanup(located, chain, set, options);
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
      );
      yield* awaitMerge(project.path, pr, outcome, "land", reporter);
      // The wait can take as long as the checks do, time enough for new
      // work in the worktree, so the guards run again.
      if (outcome.outcome !== "merged" && !worktree.isPrimary) {
        yield* worktrees.checkRemovable(located, options.force);
      }
      method = outcome.method;
    }
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
    const plan = yield* planStackCleanup(located, chain, [], options);
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
    // an ancestor of the primary ref, or the head of a merged PR (a
    // squash merge leaves no ancestry).
    if (
      branch !== target.primaryBranch &&
      !options.force &&
      !(yield* git
        .isAncestor(project.path, branch, target.primaryRef)
        .pipe(Effect.orElseSucceed(() => false))) &&
      !(yield* github.hasMergedPullRequest(project.path, branch))
    ) {
      return yield* refuse(
        "done",
        "not-merged",
        [],
        [branch, target.primaryRef],
      );
    }
    const deleted = yield* execDone(project, target, worktree, true);
    const row = yield* describeAfterDone(
      project,
      worktree,
      yield* worktrees.identities(project),
    );
    return doneDocument(row, branch, deleted, {});
  });

  return Landing.of({ pullRequest, merge, land, removeStack, done });
});

export const layer = Layer.effect(Landing, make);
