import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Loader2,
  MinusCircle,
} from "lucide-react";
import { notifyError } from "@/lib/toast";
import type { PullRequestTone } from "@/lib/pullRequest";
import type {
  PullRequestCheckBucket,
  PullRequestDetail,
} from "@shared/schemas";

export function openPullRequest(url: string): void {
  window.api.shell
    .openExternal(url)
    .catch((err) => notifyError("Couldn't open pull request", err));
}

export const STATE_LABEL: Record<PullRequestDetail["state"], string> = {
  OPEN: "Open",
  MERGED: "Merged",
  CLOSED: "Closed",
};

export const TONE_TEXT: Record<PullRequestTone, string> = {
  emerald: "text-emerald-500",
  violet: "text-violet-500",
  rose: "text-rose-500",
  slate: "text-muted-foreground",
  amber: "text-amber-500",
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
