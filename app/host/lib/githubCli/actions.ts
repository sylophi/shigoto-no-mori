import * as Schema from "effect/Schema";
import {
  CommitHashSchema,
  PullRequestSchema,
} from "@shigomori/contracts/schemas";
import { run } from "../git/core";
import { getMergeBaseDiff } from "../git/diff";
import { hasCommit } from "../git/refs";
import { isCommandError, stderrOf } from "../util/processes";
import { execGh, trimGhError } from "./exec";
import { evictProjectPullRequests } from "./pullRequests";
import { ghReady } from "./readiness";
import { remoteNameForUrl } from "./remote";

// Every action here shares one policy: gate on readiness, then rethrow
// gh failures with a trimmed message the renderer can show inline.
// `fallback` covers a gh that failed without a word.
async function runGh(
  args: string[],
  opts: { cwd: string; fallback: string; maxBuffer?: number; timeout?: number },
): Promise<string> {
  if (!(await ghReady())) {
    throw new Error("GitHub CLI isn't ready");
  }
  try {
    const { stdout } = await execGh(args, {
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer,
      timeout: opts.timeout,
    });
    return stdout;
  } catch (err) {
    if (!isCommandError(err)) throw err;
    // gh vanished between the readiness probe (cached 30s) and this
    // spawn. "Not installed" reads as a state rather than a bug.
    if (err.reason === "not-found") {
      throw new Error("GitHub CLI isn't installed", { cause: err });
    }
    if (err.reason === "timed-out") {
      throw new Error("GitHub CLI timed out", { cause: err });
    }
    throw new Error(trimGhError(stderrOf(err)) || opts.fallback, {
      cause: err,
    });
  }
}

// Streams `gh pr diff <num>` as plain unified diff text, ready to hand
// to DiffView. Throws on gh failure so the renderer can show the error
// inline (vs. silently rendering an empty diff).
export async function getPullRequestDiff(opts: {
  cwd: string;
  number: number;
}): Promise<string> {
  // PR diffs are usually small but can run into the MB range; bump the
  // buffer so a sprawling PR doesn't ENOBUFS, and give the transfer
  // more room than the default gh timeout.
  try {
    return await runGh(["pr", "diff", String(opts.number)], {
      cwd: opts.cwd,
      fallback: "gh pr diff failed",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    if (!isDiffTooLarge(err)) throw err;
    return getLocalPullRequestDiff(opts.cwd, opts.number);
  }
}

// GitHub won't produce a diff past 300 files or 20,000 lines, and
// answers with HTTP 406 and a `too_large` code instead. The code is what
// is matched, since a proxy can answer 406 for its own reasons. runGh
// keeps only the last line of gh's stderr in the message, so the whole
// of it is read off the cause.
function isDiffTooLarge(err: unknown): boolean {
  const cause = err instanceof Error ? err.cause : undefined;
  return isCommandError(cause) && /\btoo_large\b/.test(stderrOf(cause));
}

const decodeGhPrCommits = Schema.decodeUnknownSync(
  Schema.Struct({
    url: PullRequestSchema.fields.url,
    baseRefOid: CommitHashSchema,
    headRefOid: CommitHashSchema,
  }),
);

// The same diff, computed by git from the two commits GitHub has on
// record for the PR. The head is the pushed one, so a local branch that
// is ahead of it or behind it doesn't change the answer. Either commit
// can be missing here (a base that moved since the last fetch, a fork's
// head), and those are fetched by hash from the remote that holds the
// PR, into the object store and no ref.
async function getLocalPullRequestDiff(
  cwd: string,
  number: number,
): Promise<string> {
  const raw = await runGh(
    ["pr", "view", String(number), "--json", "url,baseRefOid,headRefOid"],
    { cwd, fallback: "gh pr view failed" },
  );
  const pr = decodeGhPrCommits(JSON.parse(raw));
  const oids = [pr.baseRefOid, pr.headRefOid];
  const present = await Promise.all(oids.map((oid) => hasCommit(cwd, oid)));
  const missing = oids.filter((_, i) => !present[i]);
  if (missing.length > 0) {
    const remote = await remoteNameForUrl(cwd, pr.url);
    if (!remote) {
      throw new Error(
        `This pull request is too large for GitHub to diff, and no git ` +
          `remote points at ${pr.url} to fetch it from.`,
      );
    }
    await run(cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      remote,
      ...missing,
    ]);
  }
  return getMergeBaseDiff(cwd, pr.baseRefOid, pr.headRefOid);
}

// Flips a PR between draft and ready for review. `gh pr ready` toggles
// to ready; `--undo` flips back to draft. Both call paths invalidate
// the sidebar cache because isDraft is part of the slim PullRequest.
export async function setPullRequestDraft(opts: {
  cwd: string;
  number: number;
  draft: boolean;
}): Promise<void> {
  const { cwd, number, draft } = opts;
  const args = ["pr", "ready", String(number)];
  if (draft) args.push("--undo");
  await runGh(args, { cwd, fallback: "gh pr ready failed" });
  evictProjectPullRequests(cwd);
}

// Turns an armed auto-merge off again, so the PR waits for a person.
// The slim PullRequest doesn't carry the flag, so the sidebar cache
// stays.
export async function disablePullRequestAutoMerge(opts: {
  cwd: string;
  number: number;
}): Promise<void> {
  await runGh(["pr", "merge", String(opts.number), "--disable-auto"], {
    cwd: opts.cwd,
    fallback: "gh pr merge --disable-auto failed",
  });
}
