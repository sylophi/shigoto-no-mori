// A failure as `sm --json` reports it: the words a person reads, and the
// stable code the app maps without reading prose. The terminal prints
// it, and a verb whose document goes on after a failure (land's cleanup
// after its merge) carries it.
import * as Predicate from "effect/Predicate";

export type ErrorDocument = {
  readonly error: string;
  readonly code?: string;
};

// What a failure says: the words of the git or gh that failed, or of the
// hook or checkout under it, else the error's own message.
export const messageOf = (error: unknown): string => {
  const cause = Predicate.hasProperty(error, "cause") ? error.cause : undefined;
  const said = (fallback: string) =>
    cause instanceof Error ? cause.message : fallback;
  if (Predicate.isTagged(error, "GitCommandError")) {
    return said(String((error as { message?: unknown }).message));
  }
  if (Predicate.isTagged(error, "GitHubCliError")) {
    const reason = (error as { reason?: unknown }).reason;
    return reason === "missing"
      ? "GitHub CLI isn't installed"
      : reason === "timeout"
        ? "gh timed out"
        : said("gh failed");
  }
  if (Predicate.isTagged(error, "HookFailed")) {
    return `post-checkout hook: ${messageOf(cause)}`;
  }
  if (Predicate.isTagged(error, "CheckoutUnfinished")) return messageOf(cause);
  return error instanceof Error ? error.message : String(error);
};

// The codes the app branches on, by error tag.
const CODES: Readonly<Record<string, string>> = {
  UnknownWorktree: "unknown-worktree",
  PullRequestOwnsDescription: "pull-request-open",
};

export const codeOf = (error: unknown): string | undefined => {
  if (Predicate.isTagged(error, "DirtyWorktree")) {
    return (error as { reason?: unknown }).reason === "uncommitted"
      ? "uncommitted-changes"
      : "status-unreadable";
  }
  if (
    Predicate.isTagged(error, "LandingRefused") &&
    (error as { reason?: unknown }).reason === "fork"
  ) {
    return "fork-pull-request";
  }
  for (const [tag, code] of Object.entries(CODES)) {
    if (Predicate.isTagged(error, tag)) return code;
  }
  return undefined;
};

export const errorDocument = (error: unknown): ErrorDocument => {
  const code = codeOf(error);
  return code === undefined
    ? { error: messageOf(error) }
    : { error: messageOf(error), code };
};
