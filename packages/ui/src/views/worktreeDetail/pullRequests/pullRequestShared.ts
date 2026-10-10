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
import type { PullRequestTone } from "../../../lib/pullRequest.ts";
import type {
  PullRequestCheckBucket,
  PullRequestDetail,
  PullRequestReviewerState,
} from "@shigomori/contracts/schemas/index";

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

export const CHECK_BUCKET_ICON: Record<
  PullRequestCheckBucket,
  { Icon: typeof CircleCheck; tone: PullRequestTone; label: string }
> = {
  passed: { Icon: CircleCheck, tone: "emerald", label: "Passed" },
  failing: { Icon: CircleAlert, tone: "rose", label: "Failing" },
  pending: { Icon: Loader2, tone: "amber", label: "Pending" },
  neutral: { Icon: MinusCircle, tone: "slate", label: "Neutral" },
  skipped: { Icon: CircleSlash, tone: "slate", label: "Skipped" },
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
