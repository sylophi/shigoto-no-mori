import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/toast";
import { describePullRequest, type PullRequestTone } from "@/lib/pullRequest";
import { useWorktreePullRequest } from "@/hooks/useWorktreePullRequest";
import type { Worktree } from "@shared/schemas";

interface Props {
  worktree: Worktree;
  // Parent measures the row and toggles this off when there isn't room
  // for both the title and a non-truncated branch name.
  showTitle?: boolean;
}

export function PullRequestBadge({ worktree, showTitle = false }: Props) {
  const { data: pr } = useWorktreePullRequest(
    worktree.projectId,
    worktree.branch,
  );
  if (!pr) return null;

  const { Icon, tone, label } = describePullRequest(pr);
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

const TONE_CLASSES: Record<PullRequestTone, string> = {
  emerald:
    "text-emerald-500 hover:bg-emerald-500/10 focus-visible:outline-emerald-500",
  violet:
    "text-violet-500 hover:bg-violet-500/10 focus-visible:outline-violet-500",
  rose: "text-rose-500 hover:bg-rose-500/10 focus-visible:outline-rose-500",
  slate:
    "text-muted-foreground hover:bg-muted focus-visible:outline-muted-foreground",
};
