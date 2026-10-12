// What a failure says, for a log line, a status or a refusal: a git the
// engine ran in git's own words (its stderr), as `sm` prints it, one
// that never ran in the words the app has always used, and anything
// else by its message.
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Git from "@shigomori/engine/Git";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";

export const errorWordsOf = (error: unknown): string => {
  if (!(error instanceof Git.GitCommandError)) return errorMessageOf(error);
  if (error.exitCode !== null) return Git.stderrOf(error);
  const cause = error.cause;
  if (
    !(cause instanceof PlatformError.PlatformError) ||
    !Predicate.isTagged(cause.reason, "NotFound")
  ) {
    return "git did not finish.";
  }
  // The spawn checks the folder it runs in first: a worktree deleted
  // under the app fails there, before git is looked for.
  return cause.reason.module === "ChildProcess"
    ? "git is not installed."
    : `${String(cause.reason.pathOrDescriptor)} is not there anymore.`;
};
