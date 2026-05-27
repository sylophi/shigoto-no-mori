import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PullRequestTone } from "@/lib/pullRequest";
import { TONE_TEXT } from "./pullRequestShared";

export function MergeStateIcon({ tone }: { tone: PullRequestTone }) {
  const Icon =
    tone === "rose" || tone === "amber"
      ? CircleAlert
      : tone === "slate"
        ? CircleDashed
        : CircleCheck;
  return (
    <Icon aria-hidden className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} />
  );
}
