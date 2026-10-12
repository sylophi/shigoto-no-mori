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
  return error.cause instanceof PlatformError.PlatformError &&
    Predicate.isTagged(error.cause.reason, "NotFound")
    ? "git is not installed."
    : "git did not finish.";
};
