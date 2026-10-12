import type { Ref } from "react";
import { ChevronDown, Pencil } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { Markdown } from "../../primitives/markdown.tsx";
import { Textarea } from "../../primitives/textarea.tsx";
import { cn } from "../../lib/utils.ts";

// What the worktree's work is, as its pull request's body says once it
// has one, else as `sm describe` put it (useWorktreeTitle). Markdown,
// since a PR body is. A long one starts cut down to a few lines, faded
// out at the cut, with a toggle to read the rest. No heading: it
// follows the page's header the way GitHub shows a PR's body under its
// title. DescriptionSection measures whether it is cut down, and where
// the pencil goes.
//
// The pencil waits for the cursor on the description, like the title's.
// It takes no width from the text: at the end of a one-line description
// it lies over the room left there, and otherwise it sits at the right
// of the row under it, folded or open. Narrowing the text could fold it,
// which would move the pencil and unfold it again.
export function DescriptionSectionView({
  description,
  imageHosts,
  expanded,
  onToggle,
  truncated,
  bodyRef,
  onEdit,
  pencilBeside = false,
}: {
  description: string;
  // The hosts beside GitHub's its images may load from (Markdown).
  imageHosts?: readonly string[];
  expanded: boolean;
  onToggle: () => void;
  // The text runs past its few lines while folded. Open, nothing is
  // cut, and the toggle stays to fold it back.
  truncated: boolean;
  bodyRef?: Ref<HTMLDivElement>;
  // Absent where the description can't be changed from here.
  onEdit?: () => void;
  // The text is one line with room for the pencil at its end.
  pencilBeside?: boolean;
}) {
  const showToggle = expanded || truncated;
  const pencil = onEdit && (
    <IconButton
      onClick={onEdit}
      aria-label="Edit description"
      className={cn(
        "text-muted-foreground/50 opacity-0 transition-opacity group-hover/description:opacity-100 focus-visible:opacity-100 phone:opacity-100",
        pencilBeside
          ? "absolute top-1/2 -right-1 -translate-y-1/2"
          : "mr-1 ml-auto",
      )}
    >
      <Pencil className="size-3.5" />
    </IconButton>
  );
  return (
    <section className="group/description space-y-3">
      <div className="relative max-w-3xl">
        <div
          ref={bodyRef}
          className={cn(
            !expanded && "max-h-28 overflow-hidden",
            !expanded &&
              truncated &&
              "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
          )}
        >
          <Markdown source={description} imageHosts={imageHosts} />
        </div>
        {pencilBeside && pencil}
      </div>
      {(showToggle || (pencil && !pencilBeside)) && (
        <div className="max-w-3xl">
          <div className="-mx-2 flex items-center gap-1">
            {showToggle && (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {expanded ? "Show less" : "Show more"}
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-3.5 opacity-60",
                    expanded && "rotate-180",
                  )}
                />
              </button>
            )}
            {!pencilBeside && pencil}
          </div>
        </div>
      )}
    </section>
  );
}

// The description edited as its markdown, in its place.
export function DescriptionEditorView({
  draft,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: string;
  saving: boolean;
  onChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="max-w-3xl space-y-2">
      <Textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: editing
        autoFocus
        aria-label="Description"
        rows={8}
        value={draft}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="w-full resize-y px-3 py-2 font-mono text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          Save
        </Button>
      </div>
    </section>
  );
}
