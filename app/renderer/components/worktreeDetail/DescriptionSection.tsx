import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { SectionHeading } from "@/components/ui/section-heading";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import { cn } from "@/lib/utils";

// What the worktree's work is, as its pull request's body says once it
// has one, else as `sm describe` put it (useWorktreeTitle). Markdown,
// since a PR body is. A long one starts cut down to a few lines, faded
// out at the cut, with a toggle to read the rest.
export function DescriptionSection({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(false);
  // Open, nothing is cut, and the toggle stays to fold it back.
  const [ref, truncated] = useIsTruncated<HTMLDivElement>(description);
  return (
    <section className="space-y-3">
      <SectionHeading>Description</SectionHeading>
      <div
        ref={ref}
        className={cn(
          !expanded && "max-h-28 overflow-hidden",
          !expanded &&
            truncated &&
            "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
        )}
      >
        <Markdown source={description} />
      </div>
      {(expanded || truncated) && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="-mx-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? "Show less" : "Show more"}
          <ChevronDown
            aria-hidden
            className={cn("size-3.5 opacity-60", expanded && "rotate-180")}
          />
        </button>
      )}
    </section>
  );
}
