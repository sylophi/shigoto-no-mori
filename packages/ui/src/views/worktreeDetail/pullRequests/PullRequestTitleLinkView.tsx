import type { ComponentProps, ReactNode } from "react";
import type { PullRequest } from "@shigomori/contracts/schemas/index";
import { cn } from "../../../lib/utils.ts";
import { useOutside } from "../../../outside.tsx";

// The PR's title as the link to it on GitHub. Shared with the stack
// list, whose rows are the same link one per layer, and the page's PR
// header, whose number is the link (`children` in place of the title).
export function PullRequestTitleLinkView({
  pr,
  className,
  children,
  ...props
}: {
  pr: PullRequest;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentProps<"button">, "title" | "onClick">) {
  const { openUrl } = useOutside();
  return (
    <button
      type="button"
      onClick={() => openUrl(pr.url, "Couldn't open pull request")}
      className={cn(
        "rounded text-left text-foreground transition-colors select-text hover:text-primary focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {children ?? pr.title}
    </button>
  );
}
