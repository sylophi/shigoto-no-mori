import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { PullRequest } from "@shared/schemas";

export type PullRequestTone = "emerald" | "violet" | "rose" | "slate";

export interface PullRequestDescriptor {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: PullRequestTone;
  label: string;
}

export function describePullRequest(pr: PullRequest): PullRequestDescriptor {
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
