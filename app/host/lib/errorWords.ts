// What a failure says, for a log line, a status or a refusal: a git the
// engine ran in git's own words (its stderr), as `sm` prints it, and
// anything else by its message.
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Git from "@shigomori/engine/Git";

export const errorWordsOf = (error: unknown): string =>
  error instanceof Git.GitCommandError
    ? Git.stderrOf(error)
    : errorMessageOf(error);
