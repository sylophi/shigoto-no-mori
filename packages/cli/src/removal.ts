// A worktree's removal as `rm`, `land` and `done` take and report it:
// the flags, and the word for a shell left standing in a folder gone.
import * as Effect from "effect/Effect";
import * as Flag from "effect/cli/Flag";
import { cwdInside } from "./here.ts";
import { note, Output, styles } from "./output.ts";

export const removeFlags = {
  force: Flag.Boolean("force").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Remove it with uncommitted changes"),
    Flag.withDefault(false),
  ),
  keepBranch: Flag.Boolean("keep-branch").pipe(
    Flag.withDescription("Keep its branch"),
    Flag.withDefault(false),
  ),
  skipCleanup: Flag.Boolean("skip-cleanup").pipe(
    Flag.withDescription("Skip its teardown and port release"),
    Flag.withDefault(false),
  ),
};

// Where a shell standing in the removed folder goes: the project's
// primary checkout. Empty when it stands elsewhere.
export const cdHintFor = (removedPath: string, projectPath: string) =>
  cwdInside(removedPath) ? projectPath : "";

// Where to go when the shell stands in a folder that is gone: "the
// removed worktree" or "the old location".
export const cdNote = (what: string, path: string) =>
  Effect.flatMap(Effect.service(Output), ({ stderrColor }) =>
    note(
      styles(stderrColor).dim(
        `note: your shell is inside ${what}. Run \`cd ${path}\``,
      ),
    ),
  );
