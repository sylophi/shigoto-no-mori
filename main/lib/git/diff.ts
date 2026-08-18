import { runLenient } from "./core";

// Unified patch of every uncommitted change in the worktree. Combines
// `git diff HEAD` (covers staged + unstaged tracked edits) with a
// /dev/null diff per untracked file so additions render alongside
// modifications in @pierre/diffs. `runLenient` swallows the non-zero
// exits `git diff --no-index` always emits when there's a diff.
export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  const [tracked, lsOutput] = await Promise.all([
    runLenient(worktreePath, ["diff", "HEAD", "--no-color"]),
    runLenient(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const untracked = lsOutput.split("\0").filter((s) => s.length > 0);
  const additions = await Promise.all(
    untracked.map((file) =>
      // `--` keeps a filename like `-weird.txt` from being parsed as flags.
      runLenient(worktreePath, [
        "diff",
        "--no-index",
        "--no-color",
        "--",
        "/dev/null",
        file,
      ]),
    ),
  );
  return [tracked, ...additions].filter((s) => s.length > 0).join("");
}

// Unified patch of a single commit, with the commit metadata stripped
// (`--format=`) so the output feeds straight into @pierre/diffs'
// `parsePatchFiles`. Returns empty for commits without diffs (e.g. an
// unconfigured merge commit).
export async function getCommitDiff(
  worktreePath: string,
  hash: string,
): Promise<string> {
  // `--end-of-options` is what actually pins `hash` to the revision slot.
  // A trailing `--` only bounds the pathspec list, so on its own it would
  // still let a hash like `--output=FILE` be parsed as a flag and hand a
  // malicious repo an arbitrary file write.
  return runLenient(worktreePath, [
    "show",
    "--format=",
    "--no-color",
    "--end-of-options",
    hash,
    "--",
  ]);
}
