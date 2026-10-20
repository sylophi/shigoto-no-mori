// A failure as `sm --json` reports it: the words a person reads, and the
// stable code the app maps without reading prose. The terminal prints
// it, and a verb whose document goes on after a failure (land's cleanup
// after its merge) carries it.
import * as Predicate from "effect/Predicate";
import { CheckoutUnfinished, HookFailed } from "./CloneCheckout.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import { UnknownProject } from "./Registry.ts";
import { NoScripts } from "./Scripts.ts";
import { UpdateInProgress } from "./stagingLock.ts";
import { storeErrorOf } from "./storeErrors.ts";
import { DirtyWorktree, UnknownWorktree } from "./Worktrees.ts";
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
  if (error instanceof Git.GitCommandError) return Git.stderrOf(error);
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

export const codeOf = (error: unknown): string | undefined => {
  const store = storeErrorOf(error);
  if (store !== undefined) return store.documentCode;
  if (error instanceof DirtyWorktree) {
    return error.reason === "uncommitted"
      ? "uncommitted-changes"
      : "status-unreadable";
  }
  if (error instanceof UnknownProject) return "unknown-project";
  if (error instanceof UnknownWorktree) return "unknown-worktree";
  if (error instanceof NoScripts) return "no-scripts";
  if (error instanceof UpdateInProgress) return "update-in-progress";
  // A tag, not the class: Landing imports this module.
  if (
    Predicate.isTagged(error, "LandingRefused") &&
    Predicate.hasProperty(error, "reason")
  ) {
    if (error.reason === "fork") return "fork-pull-request";
    if (error.reason === "unpushed") return "unpushed-commits";
  }
  // An error that names its own code for the document, which no Node or
  // platform error does.
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
