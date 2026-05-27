import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/toast";
import type { PullRequestCheck } from "@shared/schemas";
import { CHECK_BUCKET_ICON, TONE_TEXT } from "./pullRequestShared";

export function CheckEntry({ check }: { check: PullRequestCheck }) {
  const { Icon, tone } = CHECK_BUCKET_ICON[check.bucket];
  const isPending = check.bucket === "pending";
  const Body = (
    <>
      <Icon
        aria-hidden
        className={cn(
          "size-3 shrink-0",
          TONE_TEXT[tone],
          isPending && "animate-spin",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {check.name}
      </span>
      {check.url && (
        <ExternalLink
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover/check:opacity-100"
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
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        window.api.shell
          .openExternal(url)
          .catch((err) => notifyError("Couldn't open check", err));
      }}
      className="group/check flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      {Body}
    </a>
  );
}
