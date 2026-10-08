// A failure as `sm --json` reports it: the words a person reads, and the
// stable code the app maps without reading prose. The terminal prints
// it, and a verb whose document goes on after a failure (land's cleanup
// after its merge) carries it.
import * as Predicate from "effect/Predicate";
import { CheckoutUnfinished, HookFailed } from "./CloneCheckout.ts";
import * as Git from "./Git.ts";
import * as GitHub from "./GitHub.ts";
import { UpdateInProgress, wordsOf } from "./Updater.ts";
import {
  DirtyWorktree,
  PullRequestOwnsDescription,
  UnknownWorktree,
} from "./Worktrees.ts";

export type ErrorDocument = {
  readonly error: string;
  readonly code?: string;
};

// What a failure says: the words of the git or gh that failed, or of the
// hook or checkout under it, else the error's own message.
export const messageOf = (error: unknown): string => {
  if (error instanceof Git.GitCommandError) return Git.stderrOf(error);
  if (error instanceof GitHub.GitHubCliError) {
    return GitHub.commandMessageOf(error);
  }
  if (error instanceof HookFailed) {
    return `post-checkout hook: ${messageOf(error.cause)}`;
  }
  if (error instanceof CheckoutUnfinished) return messageOf(error.cause);
  const updater = wordsOf(error);
  if (updater !== undefined) return updater;
  return error instanceof Error ? error.message : String(error);
};

export const codeOf = (error: unknown): string | undefined => {
  if (error instanceof DirtyWorktree) {
    return error.reason === "uncommitted"
      ? "uncommitted-changes"
      : "status-unreadable";
  }
  if (error instanceof UnknownWorktree) return "unknown-worktree";
  if (error instanceof PullRequestOwnsDescription) return "pull-request-open";
  if (error instanceof UpdateInProgress) return "update-in-progress";
  // A tag, not the class: Landing imports this module.
  if (
    Predicate.isTagged(error, "LandingRefused") &&
    Predicate.hasProperty(error, "reason") &&
    error.reason === "fork"
  ) {
    return "fork-pull-request";
  }
  return undefined;
};

export const errorDocument = (error: unknown): ErrorDocument => {
  const code = codeOf(error);
  return code === undefined
    ? { error: messageOf(error) }
    : { error: messageOf(error), code };
};
