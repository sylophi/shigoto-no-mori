// A failure as `sm --json` reports it: the words a person reads, and the
// stable code the app maps without reading prose. The terminal prints
// it, and a verb whose document goes on after a failure (land's cleanup
// after its merge) carries it.
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import { CheckoutUnfinished, HookFailed } from "./CloneCheckout.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import { storeErrorOf } from "./storeErrors.ts";
import { errorMessageOf } from "@shigomori/contracts/errors";

export type ErrorDocument = {
  readonly error: string;
  readonly code?: string;
  // The terminal's way past a refusal (a flag), which the app's own
  // words and buttons stand in for.
  readonly hint?: string;
};

// What a failure says: the words of the git or gh that failed, or of the
// hook or checkout under it, else the error's own message.
export const messageOf = (error: unknown): string => {
  if (error instanceof Git.GitCommandError) return gitWordsOf(error);
  const store = storeErrorOf(error);
  if (store !== undefined) return store.message;
  if (error instanceof GitHub.GitHubCliError) {
    return GitHub.commandMessageOf(error);
  }
  if (error instanceof HookFailed) {
    return `post-checkout hook: ${messageOf(error.cause)}`;
  }
  if (error instanceof CheckoutUnfinished) return messageOf(error.cause);
  // A tag, not the class: Landing imports this module.
  if (
    Predicate.isTagged(error, "MergeUnverified") &&
    Predicate.hasProperty(error, "cause") &&
    error instanceof Error
  ) {
    return `${error.message} gh said: ${messageOf(error.cause)}`;
  }
  return errorMessageOf(error);
};

// What a failure says, set inside another sentence: with no stop of its
// own.
export const clauseOf = (error: unknown): string =>
  messageOf(error).trimEnd().replace(/\.$/, "");

// git's own words (its stderr), or why it never ran.
const gitWordsOf = (error: Git.GitCommandError): string => {
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

// The store's code, else the one an error names for itself, which no
// Node or platform error does.
export const codeOf = (error: unknown): string | undefined => {
  const store = storeErrorOf(error);
  if (store !== undefined) return store.documentCode;
  return Predicate.hasProperty(error, "documentCode") &&
    typeof error.documentCode === "string"
    ? error.documentCode
    : undefined;
};

// Whether the command line was what was wrong, which the terminal exits
// 2 for: the error says so itself.
export const isUsage = (error: unknown): boolean =>
  Predicate.hasProperty(error, "usage") && error.usage === true;

export const errorDocument = (error: unknown): ErrorDocument => {
  const code = codeOf(error);
  const hint = hintOf(error);
  return {
    error: messageOf(error),
    ...(code === undefined ? {} : { code }),
    ...(hint === undefined ? {} : { hint }),
  };
};

// A failure's words with its hint after them, as the terminal says it.
// The words may end in another program's own (gh's), with no stop.
export const withHint = (error: string, hint?: string): string => {
  if (hint === undefined) return error;
  const words = error.trimEnd();
  return `${words}${/[.!?]$/.test(words) ? "" : "."} ${hint}`;
};

const hintOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "flagHint") && typeof error.flagHint === "string"
    ? error.flagHint
    : undefined;
