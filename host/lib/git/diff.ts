import { PATCH_MAX_BUFFER, runLenient } from "./core";

// The diff of one file in the working tree: what the changes page asks
// for as you pick files, instead of reading the whole tree and slicing.
// Nothing here can go stale against a list built somewhere else -- the
// answer is whatever git says about this path right now.
//
// Which comparison to make is the caller's to say, from the status row
// it drew the file from. `diff HEAD` covers a tracked file whether its
// edits are staged, not staged, or both. A file git has never seen is
// in neither HEAD nor the index, and only compares against /dev/null.
// Asking git instead -- running the first and reading empty output as
// "must be the other kind" -- gets a staged edit that was reverted in
// the working tree wrong, and renders it as a new file.
//
// `paths` is the file, and its old name first when git records a
// rename -- handing over both is what makes the pair one entry rather
// than an unexplained addition.
export function getFileDiff(
  worktreePath: string,
  paths: readonly string[],
  untracked: boolean,
): Promise<string> {
  const file = paths[paths.length - 1];
  if (file === undefined) return Promise.resolve("");
  // `--` keeps a filename like `-weird.txt` from being parsed as flags,
  // and `runLenient` swallows the non-zero exit `--no-index` makes
  // whenever it has a diff to print.
  const args = untracked
    ? ["diff", "--no-index", "--no-color", "--", "/dev/null", file]
    : ["diff", "HEAD", "--no-color", "--", ...paths];
  return runLenient(
    worktreePath,
    // Every path here came out of `git status`, so it is a filename and
    // never a pattern. Without this a file called `a[1].txt` is a glob,
    // and the pane for one file quietly answers with another's hunks.
    ["-c", "core.quotePath=false", "--literal-pathspecs", ...args],
    { maxBuffer: PATCH_MAX_BUFFER },
  );
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
