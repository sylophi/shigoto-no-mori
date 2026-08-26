import { runLenient, splitZ } from "./core";

// Files git can see in the working tree: everything tracked, plus untracked
// files that aren't gitignored. `-z` keeps paths with spaces or newlines
// intact and skips git's octal-quoting of unusual names. Because ignored
// paths are excluded, build output (dist/, .next/) and node_modules stay
// invisible — yet a freshly created favicon resolves before it's committed.
// Lenient so a missing git binary or non-repo yields [] rather than throwing.
export async function listProjectFiles(projectPath: string): Promise<string[]> {
  const stdout = await runLenient(projectPath, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return splitZ(stdout);
}
