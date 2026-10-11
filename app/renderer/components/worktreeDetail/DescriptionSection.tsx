import { useLayoutEffect, useState } from "react";
import { ChevronDown, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import { useDescribeWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";

// What the pencil needs at the end of a one-line description.
const PENCIL_ROOM = 32;

// What the worktree's work is, as its pull request's body says once it
// has one, else as `sm describe` put it (useWorktreeTitle). Markdown,
// since a PR body is. A long one starts cut down to a few lines, faded
// out at the cut, with a toggle to read the rest. No heading: it
// follows the page's header the way GitHub shows a PR's body under its
// title. While no open PR holds it (`editable`), it is edited as its
// markdown in place.
export function DescriptionSection({
  worktree,
  description,
  editable,
}: {
  worktree: Worktree;
  description: string;
  editable: boolean;
}) {
  // The edit in progress, or null while idle.
  const [draft, setDraft] = useState<string | null>(null);
  const describe = useDescribeWorktree("Couldn't save the description");
  const { canCommand } = useCommandAccess();
  // The worktree's own text, or the merged PR's body it shows instead.
  const current = worktree.description ?? description;

  const cancel = () => setDraft(null);
  const save = (next: string) => {
    if (next === current) return cancel();
    describe.mutate(
      {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        description: next,
      },
      { onSuccess: cancel },
    );
  };

  if (draft !== null) {
    return (
      <DescriptionEditor
        draft={draft}
        saving={describe.isPending}
        onChange={setDraft}
        onSave={() => save(draft)}
        onCancel={cancel}
      />
    );
  }
  return (
    <DescriptionView
      // Folded again for a new text.
      key={description}
      description={description}
      onEdit={canCommand && editable ? () => setDraft(current) : undefined}
    />
  );
}

// The pencil waits for the cursor on the description, like the title's.
// It takes no width from the text: at the end of a one-line description
// it lies over the room left there, and otherwise it sits at the right
// of the row under it, folded or open. Narrowing the text could fold it,
// which would move the pencil and unfold it again.
function DescriptionView({
  description,
  onEdit,
}: {
  description: string;
  onEdit?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Open, nothing is cut, and the toggle stays to fold it back.
  const [ref, truncated] = useIsTruncated<HTMLDivElement>(description);
  const showToggle = expanded || truncated;
  const pencilBeside = useOneLineWithRoom(
    ref,
    description,
    onEdit !== undefined && !showToggle,
  );
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
        {pencilBeside && pencil}
      </div>
      {(showToggle || (pencil && !pencilBeside)) && (
        <div className="max-w-3xl">
          <div className="-mx-2 flex items-center gap-1">
            {showToggle && (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
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

// Whether the text is one line that ends with room for the pencil. Read
// off the text's own boxes, which the pencil laid over them doesn't
// move. Only measured while it could matter (`enabled`).
function useOneLineWithRoom(
  ref: React.RefObject<HTMLElement | null>,
  content: string,
  enabled: boolean,
): boolean {
  const [oneLine, setOneLine] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const check = () => {
      // The words' boxes alone: a range over the elements would answer
      // their full-width blocks too.
      const rects: DOMRect[] = [];
      const words = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      while (words.nextNode()) {
        range.selectNodeContents(words.currentNode);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0) rects.push(rect);
        }
      }
      const first = rects[0];
      if (!first) return setOneLine(false);
      // Inline code sits a little taller than the words around it, so a
      // line is told by its middle.
      const middle = (first.top + first.bottom) / 2;
      const sameLine = rects.every(
        (r) => Math.abs((r.top + r.bottom) / 2 - middle) < first.height / 2,
      );
      const end = Math.max(...rects.map((r) => r.right));
      setOneLine(
        sameLine && end + PENCIL_ROOM <= el.getBoundingClientRect().right,
      );
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, content, enabled]);
  return enabled && oneLine;
}

function DescriptionEditor({
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
