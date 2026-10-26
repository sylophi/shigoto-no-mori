import { RelativeDate } from "../../primitives/relative-date.tsx";
import { DiffStats } from "../../primitives/diff-stats.tsx";
import { pluralize } from "@shigomori/contracts/words";

// What the diff pages say under (or as) their titles, each page's
// container handing over its counts and names.

// The changes page: how much is changed, and where. Null when the
// changes couldn't be read, which is no count at all.
export function WorktreeDiffSubtitleView({
  changedCount,
  worktreeName,
}: {
  changedCount: number | null;
  worktreeName: string;
}) {
  return (
    <>
      {changedCount === null
        ? "Changes"
        : changedCount > 0
          ? `${pluralize(changedCount, "file")} changed`
          : "No changes"}{" "}
      in <span className="font-mono">{worktreeName}</span>
    </>
  );
}

// The base's picker (a BranchComboboxView), sized to end the
// subtitle's line.
export const BRANCH_DIFF_BASE_PICKER =
  "w-auto max-w-56 shrink-0 gap-1 px-1.5 py-0.5 text-xs";

// The branch's changes: its commits since where it left the base,
// counted against the primary branch only.
export function BranchDiffSubtitleView({
  commits,
  more,
}: {
  // Unknown until the history is read, and for another base.
  commits: number | undefined;
  // More commits than the history read returned.
  more: boolean;
}) {
  return commits === undefined
    ? "Since"
    : `${more ? `${commits}+ commits` : pluralize(commits, "commit")} since`;
}

// A commit: who made it and when, or only its hash when it isn't known
// (a deep link), since a known one's hash ends its details' buttons.
export function CommitBylineView({
  commit,
  hash,
}: {
  commit: { author: string; date: string } | undefined;
  hash: string | undefined;
}) {
  return commit ? (
    <>
      By {commit.author}, <RelativeDate date={commit.date} />
    </>
  ) : (
    <span className="font-mono">{hash}</span>
  );
}

// A pull request: its title and number.
export function PullRequestDiffTitleView({
  title,
  number,
}: {
  title: string;
  number: number;
}) {
  return (
    <>
      {title}{" "}
      <span className="font-normal text-muted-foreground/60">#{number}</span>
    </>
  );
}

// A pull request: what it changes, and into which branch.
export function PullRequestDiffSubtitleView({
  changedFiles,
  baseRefName,
  additions,
  deletions,
}: {
  changedFiles: number;
  baseRefName: string;
  additions: number;
  deletions: number;
}) {
  return (
    <>
      {pluralize(changedFiles, "file")} changed into{" "}
      <span className="font-mono text-foreground/80">{baseRefName}</span>
      {", "}
      <DiffStats additions={additions} deletions={deletions} />
    </>
  );
}
