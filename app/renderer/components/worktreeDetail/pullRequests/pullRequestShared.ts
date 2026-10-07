import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  FileDiff,
  Loader2,
  MessageSquare,
  MinusCircle,
} from "lucide-react";
import { openExternalUrl } from "@/lib/openExternal";
import type { PullRequestTone } from "@/lib/pullRequest";
import type {
  PullRequestCheckBucket,
  PullRequestDetail,
  PullRequestReviewerState,
} from "@shared/schemas";

export function openPullRequest(url: string): void {
  openExternalUrl(url, "Couldn't open pull request");
}

export const STATE_LABEL: Record<PullRequestDetail["state"], string> = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
};

// What the PR's author does with it, before the base branch's name.
export const MERGE_VERB: Record<PullRequestDetail["state"], string> = {
  OPEN: "is merging into",
  MERGED: "merged into",
  CLOSED: "wanted to merge into",
};

export const TONE_TEXT: Record<PullRequestTone, string> = {
  emerald: "text-emerald-500",
  violet: "text-violet-500",
  rose: "text-rose-500",
  slate: "text-muted-foreground",
  amber: "text-amber-500",
};

// The tint behind a tone's text, for a pill.
export const TONE_FILL: Record<PullRequestTone, string> = {
  emerald: "bg-emerald-500/10",
  violet: "bg-violet-500/10",
  rose: "bg-rose-500/10",
  slate: "bg-muted",
  amber: "bg-amber-500/10",
};

export const CHECK_BUCKET_ICON: Record<
  PullRequestCheckBucket,
  { Icon: typeof CircleCheck; tone: PullRequestTone }
> = {
  passed: { Icon: CircleCheck, tone: "emerald" },
  failing: { Icon: CircleAlert, tone: "rose" },
  pending: { Icon: Loader2, tone: "amber" },
  neutral: { Icon: MinusCircle, tone: "slate" },
  skipped: { Icon: CircleSlash, tone: "slate" },
};

export const REVIEWER_STATE: Record<
  PullRequestReviewerState,
  { Icon: typeof CircleCheck; tone: PullRequestTone; label: string }
> = {
  APPROVED: { Icon: CircleCheck, tone: "emerald", label: "Approved" },
  CHANGES_REQUESTED: {
    Icon: FileDiff,
    tone: "rose",
    label: "Requested changes",
  },
  COMMENTED: { Icon: MessageSquare, tone: "slate", label: "Commented" },
  REQUESTED: { Icon: CircleDashed, tone: "slate", label: "Awaiting review" },
};
