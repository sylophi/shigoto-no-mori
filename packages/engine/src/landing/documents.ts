// Landing's errors, documents and the pure helpers its areas share (EFFECT.md, section 2). `Landing.ts` re-exports what consumers use.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { errorDocument } from "../errorDocument.ts";
import * as Git from "../Git.ts";
import * as GitHub from "../GitHub.ts";
import type { MergeMethod } from "@shigomori/contracts/schemas/pullRequest";
import type { PullRequestSummary } from "../GitHub.ts";
import type { RegisteredProject } from "../Registry.ts";
import * as Worktrees from "../Worktrees.ts";

// A document `sm --json` prints for a landing verb: the fields the
// terminal and the host read by name, typed, beside the rest Go printed.
export type Document = Readonly<Record<string, unknown>> & {
  readonly ok?: boolean;
  readonly error?: string;
  readonly cleanupError?: ReturnType<typeof Worktrees.cleanupErrorOf>;
  readonly removed?: Worktrees.Removed;
  readonly worktree?: Worktrees.WorktreeRow;
  readonly deletedBranch?: string | null;
  readonly outcome?: Outcome;
  readonly merged?: Readonly<Record<string, unknown>>;
  // A stack's land or removal: the layers it removed, before its own.
  readonly stack?: { readonly removed: ReadonlyArray<Worktrees.Removed> };
};

// What landing won't do, the reason in its message. `numbers` and
// `names` are the PRs, branches and paths the message names, in order.
// A done whose checkout failed after it freed the branch, and whose
// branch delete then failed too: both said, the checkout's first.
export class DoneUnfinished extends Schema.TaggedError<DoneUnfinished>()(
  "DoneUnfinished",
  { branch: Schema.String, checkout: Schema.Defect(), delete: Schema.Defect() },
) {
  override get message(): string {
    return `${errorDocument(this.checkout).error} The branch ${this.branch} couldn't be deleted either: ${errorDocument(this.delete).error}`;
  }
}

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
      "unpushed",
      "head-unread",
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
      case "unpushed": {
        // `n0` commits on branch `a` that PR #`n1`'s head lacks, `b`
        // naming them.
        const commits = n0 === 1 ? "a commit" : `${n0} commits`;
        return this.verb === "done"
          ? `Branch ${a} has ${commits} its merged PR #${n1} never had, which deleting it would lose: ${b}. Push them to a new PR, or pass --force to discard them.`
          : this.verb === "rm"
            ? `Branch ${a} has ${commits} its merged PR #${n1} never had, which removing it would delete: ${b}. Push them to a new PR, or pass --force or --keep-branch.`
            : `Branch ${a} has ${commits} PR #${n1} doesn't have, which landing would delete: ${b}. Push them to the PR first, or pass --force to discard them.`;
      }
      case "head-unread":
        return `Couldn't read PR #${n0}'s head (${b}) to check that ${a} has no commits it lacks. Fetch it, or pass --force to discard what it lacks.`;
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

// `done` couldn't ask GitHub whether the branch merged. gh's own words
// are the cause's, which the document puts beside the message.
export class MergeUnverified extends Schema.TaggedError<MergeUnverified>()(
  "MergeUnverified",
  { branch: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't ask GitHub whether ${this.branch} was merged. Try again once gh can reach it, or pass --force to discard the branch.`;
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
export const MERGE_READ_ATTEMPTS = 5;

// How many polls in a row (about five minutes) a PR may sit BLOCKED
// with nothing the wait can see to wait on before it counts as stuck: a
// required check that never reports, say, or a rule the reads don't
// cover.
export const MERGE_STALL_POLLS = 30;

// How a land caught the base branch's checkout up after the merge, or
// why it didn't.
export type CatchUp = {
  readonly caughtUp?: {
    readonly ref: string;
    readonly name: string;
    readonly path: string;
    readonly isPrimary: boolean;
  };
  readonly catchUpSkipped?: string;
};

// Where a land's steps go as they happen: the merged layers of a stack,
// the cleanup's, the scripts of a removal.
export type Reporter = Worktrees.Reporter & {
  // A layer of a stack merged: its document, and the PR, whose title a
  // person's line names.
  readonly merged?: (
    event: Document,
    pr: PullRequestSummary,
  ) => Effect.Effect<void>;
  // How a merge by number ended, and its PR, whose title the document
  // leaves out and a person's line names.
  readonly outcome?: (
    pr: PullRequestSummary,
    outcome: MergeOutcome,
  ) => Effect.Effect<void>;
  // A PR that didn't merge on the spot, which the command now waits on
  // until GitHub merges it, and each change in what it waits on, or a
  // stack a merge queue took.
  readonly pending?: (
    pr: PullRequestSummary,
    outcome: MergeOutcome,
  ) => Effect.Effect<void>;
  readonly waiting?: (line: string) => Effect.Effect<void>;
  // A word for a person beside the document: a stack land that leaves
  // the primary checkout on a landed branch says how it gets back.
  readonly note?: (line: string) => Effect.Effect<void>;
  // The PR a land cleans up after, merged by it (with `method`) or
  // before, then the cleanup's steps: the base branch's checkout caught
  // up, and each other worktree a stack land removes.
  readonly landing?: (
    pr: PullRequestSummary,
    method: MergeMethod | undefined,
  ) => Effect.Effect<void>;
  readonly caughtUp?: (catchUp: CatchUp) => Effect.Effect<void>;
  readonly removedOther?: (removed: Worktrees.Removed) => Effect.Effect<void>;
};

// What each verb can fail with. A stack land is the cleanup of
// `rm --stack` after the merge of `merge --stack`.
export type MergeError =
  | LandingRefused
  | GitHub.GitHubCliError
  | GitHub.GitHubOutputError
  | GitHub.StackMergeFailed
  | MergeNeedsAttention
  | MergeLostTrack;
export type DoneError =
  | LandingRefused
  | DoneUnfinished
  | MergeUnverified
  | Git.GitError
  | Git.BranchNotMergedError;
export type RemoveStackError =
  | DoneError
  | GitHub.GitHubCliError
  | GitHub.GitHubOutputError
  | Worktrees.WorktreeRefused
  | Worktrees.DirtyWorktree;
export type LandError =
  | RemoveStackError
  | GitHub.StackMergeFailed
  | MergeNeedsAttention
  | MergeLostTrack;

export type RemoveOptions = {
  readonly force: boolean;
  readonly keepBranch: boolean;
  readonly skipCleanup: boolean;
};

// The fields a merge verdict needs, which only the merge paths ask for.
export const MERGE_FIELDS = ["mergeStateStatus", "autoMergeRequest"];

export const SETTLE_TIMEOUT_MS = 20 * 1000;

// Bounds the walk down a chain: the rows are a snapshot, so a loop in
// stale ones must end.
export const MAX_STACK_DEPTH = 64;

// The merge's fields in merge's document and land's "merged". No method
// means the PR was merged before the command ran.
export const mergeResultFields = (
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

export const outcomeFields = (o: MergeOutcome) => ({
  outcome: o.outcome,
  queued: o.outcome === "queued",
});

// The document of a merge that went through, landed or not.
export const mergeDocument = (
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
export function stackBelow(
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

export const projectScope = (project: RegisteredProject) =>
  ({ kind: "project", projectId: project.id, path: project.path }) as const;

export const mergedEvent = (pr: PullRequestSummary, method: MergeMethod) => ({
  event: "merged",
  number: pr.number,
  branch: pr.headRefName,
  method,
});

export const doneDocument = (
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
export const cleanupFailed = (
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
