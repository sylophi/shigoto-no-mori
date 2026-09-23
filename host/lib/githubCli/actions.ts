import { execGh, GhError, GhSpawnError } from "./exec";
import { evictProjectPullRequests } from "./pullRequests";
import { ghReady } from "./readiness";

// Every action here shares one policy: gate on readiness, then rethrow
// gh failures with a trimmed message the renderer can show inline.
// `fallback` covers the rare non-Error / empty-message throw.
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
    // gh vanished between the readiness probe (cached 30s) and this
    // spawn; "spawn gh ENOENT" would read as a bug rather than a state.
    if (err instanceof GhSpawnError && err.code === "ENOENT") {
      throw new Error("GitHub CLI isn't installed", { cause: err });
    }
    // gh's own last line, or "GitHub CLI timed out" for a timeout kill
    // (whose stderr is usually empty).
    const message =
      err instanceof GhError || err instanceof GhSpawnError ? err.message : "";
    throw new Error(message || opts.fallback, { cause: err });
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
  return runGh(["pr", "diff", String(opts.number)], {
    cwd: opts.cwd,
    fallback: "gh pr diff failed",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
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
