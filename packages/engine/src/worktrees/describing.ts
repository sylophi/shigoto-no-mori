// Worktrees' marks and descriptions: shelved and auto-pull, and the
// title and description the app and agents set. While the branch has an
// open pull request, its title and body are the worktree's, and
// describe edits the PR's instead (gh pr edit). A merged or closed one
// (an old PR on a reused branch name, too) still names the worktree in
// the app, but no longer holds its description, and describe writes the
// worktree's own again. A lookup that can't be made (no gh, no GitHub
// remote, gh not signed in) writes the worktree's own, since the app
// can't find the PR then either and shows the local text. One that fails
// otherwise (gh timing out, GitHub erroring) changes nothing: an open PR
// it missed would hide the write.
import * as Effect from "effect/Effect";
import * as GitHub from "../GitHub.ts";
import * as Paths from "../Paths.ts";
import * as Registry from "../Registry.ts";
import * as WorktreeData from "../WorktreeData.ts";
import {
  DescribeRefused,
  GO_SPACE_END,
  type Located,
  MAX_DESCRIPTION,
  MAX_TITLE,
  MarkRefused,
  PullRequestNeedsTitle,
  PullRequestUnchecked,
  UNKNOWN_BRANCH,
  type WorktreeIdentity,
  hasWorktreeData,
  isShelfable,
  trimGoSpace,
} from "./documents.ts";
import type { ListingArea } from "./listing.ts";

const refuseUnshelfable = (worktree: WorktreeIdentity, on: boolean) =>
  on && !isShelfable(worktree)
    ? Effect.fail(
        new MarkRefused({
          reason: worktree.isPrimary ? "primary" : "external",
        }),
      )
    : Effect.void;

export const makeDescribing = ({
  listing,
}: {
  readonly listing: ListingArea;
}) =>
  Effect.gen(function* () {
    const github = yield* GitHub.GitHub;
    const registry = yield* Registry.Registry;
    const data = yield* WorktreeData.WorktreeData;
    const paths = yield* Paths.Paths;
    const binary = paths.binaryName;
    const { primaryRefOf } = listing;
    const setShelved = Effect.fn("Worktrees.setShelved")(function* (
      worktree: WorktreeIdentity,
      on: boolean,
    ) {
      yield* refuseUnshelfable(worktree, on);
      yield* registry.setMark("shelved", worktree.id, on);
    });

    const setAutoPull = Effect.fn("Worktrees.setAutoPull")(function* (
      worktree: WorktreeIdentity,
      on: boolean,
    ) {
      yield* registry.setMark("autoPull", worktree.id, on);
    });

    // The open pull request that owns the description: never one on the
    // primary branch, which a fork's branch of the same name would be.
    const owningPullRequest = Effect.fn(function* (located: Located) {
      const { project, worktree } = located;
      if (worktree.detached || worktree.branch === UNKNOWN_BRANCH) {
        return { found: null };
      }
      const primary = yield* primaryRefOf(project);
      if (
        primary.remotes.length === 0 ||
        worktree.branch === primary.primaryBranch
      ) {
        return { found: null };
      }
      return yield* github.owningPullRequest(project.path, worktree.branch);
    });

    // The change written to the open pull request that holds the
    // worktree's title and description, and the PR as it now reads.
    const editPullRequest = Effect.fn(function* (
      located: Located,
      pr: GitHub.OwningPullRequest,
      change: { readonly title?: string; readonly description?: string },
    ) {
      if (change.title === "") {
        return yield* new PullRequestNeedsTitle({ number: pr.number });
      }
      yield* github.run(located.project.path, [
        "pr",
        "edit",
        String(pr.number),
        // Inline values, so text that starts with a dash isn't a flag.
        ...(change.title === undefined ? [] : [`--title=${change.title}`]),
        ...(change.description === undefined
          ? []
          : [`--body=${change.description}`]),
      ]);
      return {
        ...pr,
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.description === undefined
          ? {}
          : { body: change.description }),
      };
    });

    const description = Effect.fn("Worktrees.description")(function* (
      located: Located,
    ) {
      if (!hasWorktreeData(located.worktree)) {
        return yield* new DescribeRefused({ reason: "external", binary });
      }
      const stored = yield* data.description(
        located.project.id,
        located.worktree.id,
      );
      const pr = yield* owningPullRequest(located);
      return {
        title: stored.title,
        description: stored.description,
        pullRequest: pr.found,
        ...(pr.unavailable === undefined
          ? {}
          : { pullRequestUnavailable: pr.unavailable }),
      };
    });

    const describe = Effect.fn("Worktrees.describe")(function* (
      located: Located,
      change: { readonly title?: string; readonly description?: string },
    ) {
      if (!hasWorktreeData(located.worktree)) {
        return yield* new DescribeRefused({ reason: "external", binary });
      }
      let { title, description: text } = change;
      if (title !== undefined) {
        title = trimGoSpace(title);
        if (/[\p{Cc}]/u.test(title)) {
          return yield* new DescribeRefused({
            reason: "title-control",
            binary,
          });
        }
        if ([...title].length > MAX_TITLE) {
          return yield* new DescribeRefused({ reason: "title-length", binary });
        }
      }
      if (text !== undefined) {
        // Blank lines and trailing space go. A first line's indentation
        // stays: in markdown it can make a code block.
        text = text.replace(/^[\r\n]+/, "").replace(GO_SPACE_END, "");
        if ([...text].length > MAX_DESCRIPTION) {
          return yield* new DescribeRefused({
            reason: "description-length",
            binary,
          });
        }
      }
      // Last, once the input is known good: it asks GitHub.
      const pr = yield* owningPullRequest(located);
      if (pr.uncertain) {
        return yield* new PullRequestUnchecked({
          reason: pr.unavailable ?? "gh failed",
        });
      }
      if (pr.found !== null) {
        return {
          described: null,
          pullRequest: yield* editPullRequest(located, pr.found, {
            ...(title === undefined ? {} : { title }),
            ...(text === undefined ? {} : { description: text }),
          }),
        };
      }
      const described = yield* data.describe(
        located.project.id,
        located.worktree.id,
        {
          ...(title === undefined ? {} : { title }),
          ...(text === undefined ? {} : { description: text }),
        },
      );
      return {
        described,
        pullRequest: null,
        ...(pr.unavailable === undefined
          ? {}
          : { pullRequestUnavailable: pr.unavailable }),
      };
    });

    return { setShelved, setAutoPull, description, describe };
  });

export type DescribingArea = Effect.Success<ReturnType<typeof makeDescribing>>;
