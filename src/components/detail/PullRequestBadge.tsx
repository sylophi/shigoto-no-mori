import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/toast";
import { useProjectPullRequests } from "@/hooks/useProjectPullRequests";
import type { PullRequest, Worktree } from "@shared/schemas";

interface Props {
  worktree: Worktree;
  // Controls whether the PR title rides along after the number. The
  // parent measures the row and toggles this off when there isn't room
  // for both the title and a non-truncated branch name.
  showTitle?: boolean;
}

// Surfaces a clickable PR badge in the worktree header when a PR exists
// for the current branch. Hidden when gh isn't ready, the integration
// is off, or the branch has no PR -- the spot stays quiet otherwise.
export function PullRequestBadge({ worktree, showTitle = false }: Props) {
  const { data: prs } = useProjectPullRequests(worktree.projectId);
  const pr = prs?.[worktree.branch];
  if (!pr) return null;

  const { Icon, tone, label } = describe(pr);
  return (
    <button
      type="button"
      onClick={() => {
        window.api.shell
          .openExternal(pr.url)
          .catch((err) => notifyError("Couldn't open pull request", err));
      }}
      title={`${label} #${pr.number} — ${pr.title}`}
      className={cn(
        "tabular inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-xs whitespace-nowrap transition-colors focus-visible:outline-2",
        TONE_CLASSES[tone],
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {showTitle && <span>{pr.title}</span>}
      {`#${pr.number}`}
    </button>
  );
}

type Tone = "emerald" | "violet" | "rose" | "slate";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

const TONE_CLASSES: Record<Tone, string> = {
  emerald:
    "text-emerald-500 hover:bg-emerald-500/10 focus-visible:outline-emerald-500",
  violet:
    "text-violet-500 hover:bg-violet-500/10 focus-visible:outline-violet-500",
  rose: "text-rose-500 hover:bg-rose-500/10 focus-visible:outline-rose-500",
  slate:
    "text-muted-foreground hover:bg-muted focus-visible:outline-muted-foreground",
};

function describe(pr: PullRequest): {
  Icon: IconType;
  tone: Tone;
  label: string;
} {
  if (pr.state === "MERGED") {
    return { Icon: GitMerge, tone: "violet", label: "Merged PR" };
  }
  if (pr.state === "CLOSED") {
    return { Icon: GitPullRequestClosed, tone: "rose", label: "Closed PR" };
  }
  if (pr.isDraft) {
    return { Icon: GitPullRequestDraft, tone: "slate", label: "Draft PR" };
  }
  return { Icon: GitPullRequest, tone: "emerald", label: "Open PR" };
}
