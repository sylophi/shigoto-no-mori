import { onIndex, PATCH_MAX_BUFFER, runLenient, splitZ } from "./core";

// Unified patch of every uncommitted change in the worktree. Combines
// `git diff HEAD` (covers staged + unstaged tracked edits) with a
// /dev/null diff per untracked file so additions render alongside
// modifications in @pierre/diffs. `runLenient` swallows the non-zero
// exits `git diff --no-index` always emits when there's a diff.
// `core.quotePath=false` keeps a non-ASCII path raw in the headers, the
// same bytes `status -z` reports, so the changes page can pair a patch
// entry with its status row. Git would otherwise C-quote it ("caf\303\251").
//
// The whole read takes an index-queue slot (core.onIndex) so it sees
// one index state throughout. The two halves split the working tree
// between them at the index -- a file is untracked or it is in `diff
// HEAD`, never both -- so a tick landing mid-read moves a file across
// that line and the patch comes back with it twice (two entries under
// one path, which is a duplicate React key) or not at all.
export function getWorktreeDiff(worktreePath: string): Promise<string> {
  return onIndex(worktreePath, () => worktreeDiffNow(worktreePath));
}

async function worktreeDiffNow(worktreePath: string): Promise<string> {
  const [tracked, lsOutput] = await Promise.all([
    runLenient(
      worktreePath,
      ["-c", "core.quotePath=false", "diff", "HEAD", "--no-color"],
      { maxBuffer: PATCH_MAX_BUFFER },
    ),
    runLenient(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const untracked = splitZ(lsOutput);
  const additions = await Promise.all(
    untracked.map((file) =>
      // `--` keeps a filename like `-weird.txt` from being parsed as flags.
      runLenient(
        worktreePath,
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--no-index",
          "--no-color",
          "--",
          "/dev/null",
          file,
        ],
        { maxBuffer: PATCH_MAX_BUFFER },
      ),
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
  return runLenient(
    worktreePath,
    ["show", "--format=", "--no-color", "--end-of-options", hash, "--"],
    { maxBuffer: PATCH_MAX_BUFFER },
  );
}
