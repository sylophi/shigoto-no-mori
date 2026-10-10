import type { Ref } from "react";
import { ChevronDown } from "lucide-react";
import { Markdown } from "../../primitives/markdown.tsx";
import { cn } from "../../lib/utils.ts";

// What the worktree's work is, as its pull request's body says once it
// has one, else as `sm describe` put it (useWorktreeTitle). Markdown,
// since a PR body is. A long one starts cut down to a few lines, faded
// out at the cut, with a toggle to read the rest. No heading: it
// follows the page's header the way GitHub shows a PR's body under its
// title. DescriptionSection measures whether it is cut down.
export function DescriptionSectionView({
  description,
  expanded,
  onToggle,
  truncated,
  bodyRef,
}: {
  description: string;
  expanded: boolean;
  onToggle: () => void;
  // The text runs past its few lines while folded. Open, nothing is
  // cut, and the toggle stays to fold it back.
  truncated: boolean;
  bodyRef?: Ref<HTMLDivElement>;
}) {
  return (
    <section className="space-y-3">
      <div
        ref={bodyRef}
        className={cn(
          "max-w-3xl",
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
          onClick={onToggle}
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
