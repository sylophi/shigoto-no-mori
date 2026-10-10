import { RelativeDate } from "@/components/ui/relative-date";
import { DiffStats } from "@/components/ui/diff-stats";
import { pluralize } from "@/lib/pluralize";

// What the diff pages say under (or as) their titles, each page's
// container handing over its counts and names.

// The changes page: how much is changed, and where.
export function WorktreeDiffSubtitleView({
  changedCount,
  worktreeName,
}: {
  changedCount: number;
  worktreeName: string;
}) {
  return (
    <>
      {changedCount > 0
        ? `${pluralize(changedCount, "file")} changed`
        : "No changes"}{" "}
      in <span className="font-mono">{worktreeName}</span>
    </>
  );
}

// The branch's changes: its commits since where it left the base.
export function BranchDiffSubtitleView({
  commits,
  base,
}: {
  // Unknown until the history is read.
  commits: number | undefined;
  base: string | undefined;
}) {
  return (
    <>
      {commits !== undefined && `${pluralize(commits, "commit")} since `}
      <span className="font-mono">{base}</span>
    </>
  );
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
