import { ExternalLink } from "lucide-react";
import { cn } from "../../../lib/utils.ts";
import { useOutside } from "../../../outside.tsx";
import type { PullRequestCheck } from "@shigomori/contracts/schemas/index";
import { CHECK_BUCKET_ICON } from "./pullRequestShared.ts";
import { TONE_MARK } from "../../../primitives/status-dot.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";

export function CheckEntryView({ check }: { check: PullRequestCheck }) {
  const { openUrl } = useOutside();
  const { Icon, tone, label } = CHECK_BUCKET_ICON[check.bucket];
  const isPending = check.bucket === "pending";
  const Body = (
    <>
      <SimpleTooltip tip={label}>
        <Icon
          aria-label={label}
          className={cn(
            "size-3 shrink-0",
            TONE_MARK[tone],
            isPending && "animate-spin",
          )}
        />
      </SimpleTooltip>
      <SimpleTooltip whenTruncated tip={check.name}>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {check.name}
        </span>
      </SimpleTooltip>
      {check.url && (
        <ExternalLink
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/check:opacity-100 phone:opacity-100"
        />
      )}
    </>
  );
  if (!check.url) {
    return (
      <div className="flex items-center gap-1.5 px-1.5 py-0.5 text-xs">
        {Body}
      </div>
    );
  }
  const url = check.url;
  return (
    <button
      type="button"
      onClick={() => openUrl(url, "Couldn't open check")}
      className="group/check flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      {Body}
    </button>
  );
}
