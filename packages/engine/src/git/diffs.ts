// Git's diffs: a file's, a commit's, a branch's, as patches.
import * as Effect from "effect/Effect";
import { PATCH_MAX_OUTPUT } from "./documents.ts";
import type { RunningArea } from "./running.ts";

export const makeDiffs = ({ running }: { readonly running: RunningArea }) =>
  Effect.sync(() => {
    const { run } = running;
    // --- diffs ---

    const fileDiff = Effect.fn("Git.fileDiff")(function* (input: {
      readonly worktree: string;
      readonly paths: readonly string[];
      readonly untracked: boolean;
    }) {
      const { worktree, paths, untracked } = input;
      const file = paths.at(-1);
      if (file === undefined) return "";
      // A path is a filename, never a pattern: otherwise `a[1].txt` is a
      // glob, and the pane for one file answers with another's hunks.
      const pathspec = ["-c", "core.quotePath=false", "--literal-pathspecs"];
      // `--no-index` reads straight off the disk, so it would answer for a
      // path git doesn't count as a change (an ignored .env). Read-only
      // peers reach this, so git says first whether it is an untracked
      // change. A symlink prints where it points, never what is there.
      if (untracked) {
        const known = yield* run(worktree, [
          ...pathspec,
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          file,
        ]).pipe(Effect.orElseSucceed(() => ""));
        if (known === "") return "";
      }
      return yield* run(
        worktree,
        [
          ...pathspec,
          ...(untracked
            ? ["diff", "--no-index", "--no-color", "--", "/dev/null", file]
            : ["diff", "HEAD", "--no-color", "--", ...paths]),
        ],
        { anyExit: true, maxOutputBytes: PATCH_MAX_OUTPUT },
      ).pipe(Effect.catchTags({ GitCommandError: () => Effect.succeed("") }));
    });

    return { fileDiff };
  });

export type DiffsArea = Effect.Success<ReturnType<typeof makeDiffs>>;
