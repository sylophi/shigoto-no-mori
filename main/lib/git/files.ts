import { runLenient } from "./core";

// Tracked files, POSIX-relative to the repo root. `-z` keeps paths with
// spaces or newlines intact and skips git's octal-quoting of unusual names.
// `ls-files` defaults to the index, so build output (dist/, .next/) and
// node_modules — anything git ignores — are absent by construction. Lenient
// so an unborn/empty repo yields [] rather than throwing.
export async function listTrackedFiles(projectPath: string): Promise<string[]> {
  const stdout = await runLenient(projectPath, ["ls-files", "-z"]);
  return stdout.split("\0").filter((path) => path.length > 0);
}
