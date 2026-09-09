import { PATCH_MAX_BUFFER, runLenient } from "./core";

// The diff of one file in the working tree: what the changes page asks
// for as you pick files, instead of reading the whole tree and slicing.
// Nothing here can go stale against a list built somewhere else -- the
// answer is whatever git says about this path right now.
//
// `diff HEAD` covers a tracked file whether its edits are staged, not
// staged, or both. An untracked file is in neither HEAD nor the index,
// so it takes the /dev/null form instead. Empty output is the signal to
// try that: git already knows which kind a path is, so asking costs one
// process and knowing would cost the caller a lie to keep in sync.
//
// `paths` is the file, and its old name first when git records a
// rename -- handing over both is what makes the pair one entry rather
// than an unexplained addition.
export async function getFileDiff(
  worktreePath: string,
  paths: readonly string[],
): Promise<string> {
  const file = paths[paths.length - 1];
  if (file === undefined) return "";
  const tracked = await runLenient(
    worktreePath,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "HEAD",
      "--no-color",
      "--",
      ...paths,
    ],
    { maxBuffer: PATCH_MAX_BUFFER },
  );
  if (tracked.length > 0) return tracked;
  // `--` keeps a filename like `-weird.txt` from being parsed as flags.
  // `runLenient` swallows the non-zero exit `--no-index` always emits
  // when there is a diff to print.
  return runLenient(
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
