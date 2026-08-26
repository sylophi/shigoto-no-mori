// Checking out a pull request into a fresh worktree. Two halves: the
// picker's list of open PRs, and the resolver that turns the PR the user
// picked into a local branch. The resolver stops there on purpose --
// worktrees.create takes it from the local branch through the ordinary
// `checkout` path, so the bundled CLI stays the create engine and knows
// nothing about PRs.
import { z } from "zod";
import type {
  PullRequestCandidate,
  PullRequestCandidateList,
  PullRequestCheckoutRef,
} from "@shared/schemas";
import { forkBranchCandidates } from "@shared/branches";
import { errorMessageOf } from "@shared/errors";
import { createLocalBranch } from "../git/branches";
import { run } from "../git/core";
import { localBranchExists } from "../git/remotes";
import { execGh, trimGhError } from "./exec";
import { getGithubRepoInfo, remoteNameForUrl } from "./remote";
import { ghUnavailableReason } from "./readiness";

// Enough to fill a picker without paging. Deliberately below the
// sidebar sweep's 200: that one indexes every branch in the project,
// this one is a list a human scrolls.
const PR_CANDIDATE_LIMIT = 50;

const GhPrCandidateSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string().min(1),
  updatedAt: z.string(),
  author: z.looseObject({ login: z.string().optional() }).nullish(),
  isCrossRepository: z.boolean(),
  headRepository: z
    .looseObject({
      name: z.string().optional(),
      nameWithOwner: z.string().optional(),
    })
    .nullish(),
  headRepositoryOwner: z
    .looseObject({ login: z.string().optional() })
    .nullish(),
});
type GhPrCandidate = z.infer<typeof GhPrCandidateSchema>;

// Derived from the schema that parses the response, so the two can't
// drift into "asked for a field we don't read" or the reverse.
const CANDIDATE_JSON_FIELDS = Object.keys(GhPrCandidateSchema.shape).join(",");

// Open PRs only: the mode exists to start a review, and checking out a
// merged or closed head is the "check out source" mode's job.
export async function listPullRequestCandidates(
  cwd: string,
): Promise<PullRequestCandidateList> {
  const unavailable = await ghUnavailableReason();
  if (unavailable) return { status: "unavailable", reason: unavailable };
  if (!(await getGithubRepoInfo(cwd))) {
    return { status: "unavailable", reason: "no-github-remote" };
  }
  try {
    const { stdout } = await execGh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(PR_CANDIDATE_LIMIT),
        "--json",
        CANDIDATE_JSON_FIELDS,
      ],
      { cwd },
    );
    const rows = z.array(GhPrCandidateSchema).parse(JSON.parse(stdout));
    // gh already returns newest-first, which is the order a reviewer wants.
    return { status: "ok", pullRequests: rows.map(toCandidate) };
  } catch {
    // gh exited non-zero (network, SSO prompt, rate limit) or answered
    // with something we can't read. The form says so rather than showing
    // an empty list that reads as "no PRs".
    return { status: "unavailable", reason: "gh-failed" };
  }
}

function toCandidate(row: GhPrCandidate): PullRequestCandidate {
  const owner = row.headRepositoryOwner?.login;
  const repo = row.headRepository?.name;
  // gh reports "owner/repo" directly on newer versions. When it's
  // missing, compose it from the two sibling fields.
  const nameWithOwner =
    row.headRepository?.nameWithOwner ??
    (owner && repo ? `${owner}/${repo}` : undefined);
  return {
    number: row.number,
    url: row.url,
    title: row.title,
    isDraft: row.isDraft,
    headRefName: row.headRefName,
    authorLogin: row.author?.login ?? "ghost",
    fromFork: row.isCrossRepository,
    headRepo: row.isCrossRepository ? (nameWithOwner ?? null) : null,
    updatedAt: row.updatedAt,
  };
}

const GhPrHeadSchema = z.object({
  // The repo half of this URL is the repo gh resolved the number
  // against, which is the one we have to fetch from.
  url: z.url(),
  headRefName: z.string().min(1),
  isCrossRepository: z.boolean(),
  headRepositoryOwner: z
    .looseObject({ login: z.string().optional() })
    .nullish(),
});

// Re-read the head from gh instead of trusting a number the renderer
// carried across the wire: the picker's list can be minutes stale, and
// fetching the wrong ref into a branch is not a mistake worth being
// relaxed about.
async function readPullRequestHead(
  cwd: string,
  number: number,
): Promise<z.infer<typeof GhPrHeadSchema>> {
  let stdout: string;
  try {
    ({ stdout } = await execGh(
      [
        "pr",
        "view",
        String(number),
        "--json",
        "url,headRefName,isCrossRepository,headRepositoryOwner",
      ],
      { cwd },
    ));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new Error(
      `Couldn't read pull request #${number}: ${trimGhError(stderr) || "gh failed"}`,
      { cause: err },
    );
  }
  const parsed = GhPrHeadSchema.safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    throw new Error(`Unexpected gh pr view output for #${number}`);
  }
  return parsed.data;
}

export async function resolvePullRequestCheckout(
  cwd: string,
  number: number,
): Promise<PullRequestCheckoutRef> {
  if (await ghUnavailableReason()) {
    throw new Error("The GitHub CLI isn't available for this project.");
  }
  if (!(await getGithubRepoInfo(cwd))) {
    throw new Error("This project has no GitHub remote to fetch from.");
  }
  const head = await readPullRequestHead(cwd, number);
  // Resolved from the PR's URL rather than from "the first GitHub
  // remote": in a fork checkout both the fork and the parent are
  // remotes, and gh answered from the parent.
  const remote = await remoteNameForUrl(cwd, head.url);
  if (!remote) {
    throw new Error(
      `No git remote points at the repository holding pull request ` +
        `#${number} (${head.url}). Add one and try again.`,
    );
  }
  return head.isCrossRepository
    ? resolveForkHead(cwd, remote, number, head)
    : resolveSameRepoHead(cwd, remote, head.headRefName);
}

// Same-repo head: an ordinary remote branch. Land it on a local branch
// tracking the remote, which is what the user would have gotten by
// checking the branch out by hand -- push, pull, and the worktree page's
// ahead/behind all behave normally from there.
async function resolveSameRepoHead(
  cwd: string,
  remote: string,
  branch: string,
): Promise<PullRequestCheckoutRef> {
  // Both fetch forms below opportunistically refresh
  // refs/remotes/<remote>/<branch> as a side effect, so neither path
  // needs a second round trip to leave the tracking ref current.
  if (await localBranchExists(cwd, branch)) {
    // The <src>:<dst> refspec is fast-forward-only, so a local branch
    // that has drifted from the PR head errors out instead of quietly
    // checking out stale code. (git also refuses when the branch is
    // checked out elsewhere, which the form greys those PRs out for.)
    try {
      await run(cwd, ["fetch", "--quiet", remote, `${branch}:${branch}`]);
    } catch (err) {
      throw new Error(
        `Local branch ${branch} can't be fast-forwarded to the pull ` +
          `request head. Delete or rename it and try again. (${message(err)})`,
        { cause: err },
      );
    }
  } else {
    await run(cwd, ["fetch", "--quiet", remote, branch]);
    // Explicit rather than leaning on `git worktree add`'s DWIM, which
    // only fires when exactly one remote has the branch. createLocalBranch
    // sets --track for a remote-tracking base, which is what this is.
    await createLocalBranch(cwd, branch, `${remote}/${branch}`);
  }
  return { branch };
}

// Fork head: not on any remote we track, but GitHub publishes it on the
// base repo as refs/pull/<n>/head. Same ref `gh pr checkout` uses.
async function resolveForkHead(
  cwd: string,
  remote: string,
  number: number,
  head: z.infer<typeof GhPrHeadSchema>,
): Promise<PullRequestCheckoutRef> {
  const pullRef = `refs/pull/${number}/head`;
  const branch = await pickForkBranchName(cwd, number, head);
  // Unforced refspec: an existing branch that has diverged from the PR
  // head fails rather than discarding whatever was on it.
  try {
    await run(cwd, [
      "fetch",
      "--quiet",
      remote,
      `${pullRef}:refs/heads/${branch}`,
    ]);
  } catch (err) {
    // Non-fast-forward (the author force-pushed since this branch was
    // last checked out) and "checked out at <path>" (the PR is already
    // open in another worktree) both land here, and git's own stderr
    // says which -- the remedy is the same either way.
    throw new Error(
      `Couldn't fetch ${pullRef} onto ${branch}: ${message(err)}. Delete ` +
        `or rename ${branch} and try again.`,
      { cause: err },
    );
  }
  // What `gh pr checkout` writes for a fork the user can't push to:
  // `git pull` re-fetches the PR head, and nothing is configured to push
  // at a branch that isn't theirs. It also leaves @{upstream}
  // unresolvable, so the worktree page shows the branch as unpublished
  // -- which is true.
  await run(cwd, ["config", `branch.${branch}.remote`, remote]);
  await run(cwd, ["config", `branch.${branch}.merge`, pullRef]);
  return { branch };
}

// Reuse a branch when it's one we created for this same PR, otherwise
// take the next candidate name rather than fetching over whatever the
// user had there. The candidate list is shared with the form so the two
// agree on which PRs are already checked out.
async function pickForkBranchName(
  cwd: string,
  number: number,
  head: z.infer<typeof GhPrHeadSchema>,
): Promise<string> {
  const pullRef = `refs/pull/${number}/head`;
  const candidates = forkBranchCandidates(
    number,
    head.headRefName,
    head.headRepositoryOwner?.login,
  );
  /* oxlint-disable no-await-in-loop -- the first usable name wins, so
     probing the rest up front would be wasted git calls */
  for (const name of candidates) {
    if (!(await localBranchExists(cwd, name))) return name;
    if ((await readBranchMerge(cwd, name)) === pullRef) return name;
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error(
    `Branches ${candidates.join(" and ")} both already exist and neither ` +
      `tracks pull request #${number}. Delete or rename one and try again.`,
  );
}

async function readBranchMerge(
  cwd: string,
  branch: string,
): Promise<string | null> {
  try {
    const stdout = await run(cwd, [
      "config",
      "--get",
      `branch.${branch}.merge`,
    ]);
    return stdout.trim() || null;
  } catch {
    // Exit 1 just means the key isn't set.
    return null;
  }
}

// git failures carry the useful part on stderr. When they don't, fall
// back to the Error itself.
function message(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr;
  return typeof stderr === "string" && stderr.trim()
    ? trimGhError(stderr)
    : errorMessageOf(err);
}
