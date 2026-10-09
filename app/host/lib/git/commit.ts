// A commit from the changes page. The page keeps its own ticks rather
// than reading them off the index, so this is where they become one: the
// index goes back to HEAD, the ticked files go in whole, the files
// ticked by hunk go in as HEAD plus their picked changes, and git
// commits that. Whatever was staged before (an agent's `git mv`, a
// terminal's `git add`) goes in only if it is ticked.
import { readFile, rm, writeFile } from "node:fs/promises";
import type { CommitPicks } from "@shared/schemas";
import { onIndex, runChunked } from "./changes";
import { run, splitZ } from "./core";
import { stageHunks, staleCommit } from "./hunks";

// Two `-m` flags give git the summary and body as separate paragraphs.
// Hooks run as they would in a terminal, and their output rides along
// in the thrown error for the page to show. `amend` folds the picks
// into HEAD under the new message instead of adding a commit, and with
// nothing picked rewrites only the message. A commit git refuses (a
// hook, no identity) puts the index back the way it was, so what a
// terminal or an agent had staged survives it.
type CommitRequest = CommitPicks & {
  summary: string;
  description?: string;
  amend?: boolean;
};

export function commitPicks(
  worktreePath: string,
  message: CommitRequest,
): Promise<string> {
  return onIndex(worktreePath, async () => {
    const indexFile = (
      await run(worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])
    ).trim();
    // A repository nothing was ever added to has no index yet.
    const saved = await readFile(indexFile).catch(() => null);
    try {
      await commitWith(worktreePath, message);
    } catch (err) {
      if (saved) await writeFile(indexFile, saved);
      else await rm(indexFile, { force: true });
      throw err;
    }
    const hash = await run(worktreePath, ["rev-parse", "--short", "HEAD"]);
    return hash.trim();
  });
}

async function commitWith(
  worktreePath: string,
  message: CommitRequest,
): Promise<void> {
  // A hunk is placed by its lines in HEAD, so picks from before a new
  // HEAD (a commit from a terminal) could name other changes now.
  if (message.hunks.length > 0) {
    const head = (await run(worktreePath, ["rev-parse", "HEAD"])).trim();
    const stale = message.hunks.find((pick) => pick.base !== head);
    if (stale) throw new Error(staleCommit(stale.path));
  }
  // By path, not a bare `reset`: that one also drops MERGE_HEAD, and a
  // merge's resolution would commit as an ordinary commit.
  await run(worktreePath, ["reset", "-q", "--", "."]);
  // A file listed and then deleted before the commit (an agent's
  // scratch file) is one git no longer knows, and `add` would refuse
  // the whole lot over it.
  const known = new Set(
    (
      await runChunked(
        worktreePath,
        ["ls-files", "-z", "--cached", "--others"],
        message.paths,
      )
    ).flatMap(splitZ),
  );
  const paths = message.paths.filter((path) => known.has(path));
  // `--force` for a file staged past .gitignore (`git add -f`), which
  // the reset just unstaged.
  if (paths.length > 0) {
    await runChunked(worktreePath, ["add", "-A", "--force"], paths);
  }
  for (const { path, changes } of message.hunks) {
    // oxlint-disable-next-line no-await-in-loop -- index writes take index.lock, so files have to go one after another
    await stageHunks(worktreePath, path, changes);
  }
  const args = ["commit", "--quiet"];
  if (message.amend) args.push("--amend");
  args.push("-m", message.summary);
  const body = message.description?.trim();
  if (body) args.push("-m", body);
  await run(worktreePath, args);
}
