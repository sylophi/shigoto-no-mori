// A commit from the changes page. The page keeps its own ticks rather
// than reading them off the index, so this is where they become one: the
// index goes back to HEAD, the ticked files go in whole, the files
// ticked by hunk go in as HEAD plus their picked changes, and git
// commits that. Whatever was staged before (an agent's `git mv`, a
// terminal's `git add`) goes in only if it is ticked.
import { readFile, rm, writeFile } from "node:fs/promises";
import type { CommitPicks } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { onIndex, runChunked } from "./changes";
import { GitRefusal, run, splitZ } from "./core";
import { stageHunks, staleCommit } from "./hunks";

// Two `-m` flags give git the summary and body as separate paragraphs.
// Hooks run as they would in a terminal, and their output rides along
// in the failure for the page to show. `amend` folds the picks
// into HEAD under the new message instead of adding a commit, with no
// summary keeps HEAD's message, and with nothing picked rewrites only
// the message. A commit git refuses (a
// hook, no identity) puts the index back the way it was, so what a
// terminal or an agent had staged survives it.
type CommitRequest = CommitPicks & {
  summary?: string;
  description?: string;
  amend?: boolean;
};

export const commitPicks = (worktreePath: string, message: CommitRequest) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      const indexFile = (yield* run(worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])).trim();
      // A repository nothing was ever added to has no index yet.
      const saved = yield* Effect.promise(() =>
        readFile(indexFile).catch(() => null),
      );
      yield* commitWith(worktreePath, message).pipe(
        Effect.tapError(() =>
          Effect.promise(() =>
            saved
              ? writeFile(indexFile, saved)
              : rm(indexFile, { force: true }),
          ),
        ),
      );
      const hash = yield* run(worktreePath, ["rev-parse", "--short", "HEAD"]);
      return hash.trim();
    }),
  );

const commitWith = Effect.fnUntraced(function* (
  worktreePath: string,
  message: CommitRequest,
) {
  // A hunk is placed by its lines in HEAD, so picks from before a new
  // HEAD (a commit from a terminal) could name other changes now.
  if (message.hunks.length > 0) {
    const head = (yield* run(worktreePath, ["rev-parse", "HEAD"])).trim();
    const stale = message.hunks.find((pick) => pick.base !== head);
    if (stale) {
      return yield* new GitRefusal({ reason: staleCommit(stale.path) });
    }
  }
  // By path, not a bare `reset`: that one also drops MERGE_HEAD, and a
  // merge's resolution would commit as an ordinary commit.
  yield* run(worktreePath, ["reset", "-q", "--", "."]);
  // A file listed and then deleted before the commit (an agent's
  // scratch file) is one git no longer knows, and `add` would refuse
  // the whole lot over it.
  const known = new Set(
    (yield* runChunked(
      worktreePath,
      ["ls-files", "-z", "--cached", "--others"],
      message.paths,
    )).flatMap(splitZ),
  );
  const paths = message.paths.filter((path) => known.has(path));
  // `--force` for a file staged past .gitignore (`git add -f`), which
  // the reset just unstaged.
  if (paths.length > 0) {
    yield* runChunked(worktreePath, ["add", "-A", "--force"], paths);
  }
  // Index writes take index.lock, so files go one after another.
  for (const { path, changes } of message.hunks) {
    yield* stageHunks(worktreePath, path, changes);
  }
  const args = ["commit", "--quiet"];
  if (message.amend) args.push("--amend");
  if (message.summary === undefined) {
    args.push("--no-edit");
  } else {
    args.push("-m", message.summary);
    const body = message.description?.trim();
    if (body) args.push("-m", body);
  }
  yield* run(worktreePath, args);
});
