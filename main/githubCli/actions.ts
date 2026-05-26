import type { MergeMethod } from "@shared/schemas";
import { readShigomoriConfig, writeShigomoriConfig } from "../config/project";
import { execFileP, trimGhError } from "./exec";
import { evictProjectPullRequests } from "./pullRequests";
import { ghReady } from "./readiness";

// Streams `gh pr diff <num>` as plain unified diff text, ready to hand
// to DiffView. Throws on gh failure so the renderer can show the error
// inline (vs. silently rendering an empty diff).
export async function getPullRequestDiff(opts: {
  cwd: string;
  number: number;
}): Promise<string> {
  if (!(await ghReady())) {
    throw new Error("GitHub CLI isn't ready");
  }
  try {
    // PR diffs are usually small but can run into the MB range; bump the
    // buffer so a sprawling PR doesn't ENOBUFS.
    const { stdout } = await execFileP(
      "gh",
      ["pr", "diff", String(opts.number)],
      { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? trimGhError(err.message)
        : "gh pr diff failed";
    throw new Error(message, { cause: err });
  }
}

const MERGE_FLAG: Record<MergeMethod, string> = {
  merge: "--merge",
  squash: "--squash",
  rebase: "--rebase",
};

// Performs the actual `gh pr merge` and persists the user's pick into
// the per-project config so the split button defaults to it next time.
// Throws on gh failure -- the renderer surfaces the message inline.
export async function mergePullRequest(opts: {
  projectId: string;
  cwd: string;
  number: number;
  method: MergeMethod;
}): Promise<void> {
  const { projectId, cwd, number, method } = opts;
  if (!(await ghReady())) {
    throw new Error("GitHub CLI isn't ready");
  }
  try {
    await execFileP("gh", ["pr", "merge", String(number), MERGE_FLAG[method]], {
      cwd,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? trimGhError(err.message)
        : "gh pr merge failed";
    throw new Error(message, { cause: err });
  }
  // Best-effort: failure to persist the pref shouldn't fail the merge.
  try {
    const current = (await readShigomoriConfig(projectId).catch(
      () => null,
    )) ?? {
      defaultBranch: "main",
    };
    if (current.lastMergeMethod !== method) {
      await writeShigomoriConfig(projectId, {
        ...current,
        lastMergeMethod: method,
      });
    }
  } catch {
    // swallow
  }
  // The merge changes upstream refs (and the sidebar PR cache) -- evict
  // so the next read sees the merged state.
  evictProjectPullRequests(cwd);
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
  if (!(await ghReady())) {
    throw new Error("GitHub CLI isn't ready");
  }
  const args = ["pr", "ready", String(number)];
  if (draft) args.push("--undo");
  try {
    await execFileP("gh", args, { cwd });
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? trimGhError(err.message)
        : "gh pr ready failed";
    throw new Error(message, { cause: err });
  }
  evictProjectPullRequests(cwd);
}
