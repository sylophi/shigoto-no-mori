import { CircleAlert, CircleCheck, CircleSlash, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PullRequestTone } from "@/lib/pullRequest";
import { TONE_TEXT } from "./pullRequestShared";

export function ChecksSummaryIcon({ tone }: { tone: PullRequestTone }) {
  const Icon =
    tone === "rose"
      ? CircleAlert
      : tone === "amber"
        ? Loader2
        : tone === "slate"
          ? CircleSlash
          : CircleCheck;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        TONE_TEXT[tone],
        tone === "amber" && "animate-spin",
      )}
    />
  );
}
