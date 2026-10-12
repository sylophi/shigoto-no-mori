// The work's description (DescriptionSectionView), measured whether a
// long one is cut down and whether the pencil fits at the end of a
// one-line one. While no open PR holds it (`editable`), it is edited
// as its markdown in place (DescriptionEditorView).
import { useBinding } from "@/hooks/ui/useKeymap";
import { type RefObject, useLayoutEffect, useState } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";
import { useIsTruncated } from "@shigomori/ui/hooks/useIsTruncated.ts";
import {
  DescriptionEditorView,
  DescriptionSectionView,
} from "@shigomori/ui/views/worktreeDetail/DescriptionSectionView.tsx";
import { useProjectImageHosts } from "@/hooks/projects/useProjectImageHosts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useDescribeWorktree } from "@/hooks/worktrees/useWorktreeMutations";

// What the pencil needs at the end of a one-line description.
const PENCIL_ROOM = 32;

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
  const saveKeys = useBinding("save");
  const describe = useDescribeWorktree("Couldn't save the description");
  const { canCommand } = useCommandAccess();
  const imageHosts = useProjectImageHosts(worktree.projectId);
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
      <DescriptionEditorView
        draft={draft}
        saving={describe.isPending}
        onChange={setDraft}
        onSave={() => save(draft)}
        onCancel={cancel}
        saveKeys={saveKeys}
      />
    );
  }
  return (
    <DescriptionBody
      // Folded again for a new text.
      key={description}
      description={description}
      imageHosts={imageHosts}
      onEdit={canCommand && editable ? () => setDraft(current) : undefined}
    />
  );
}

function DescriptionBody({
  description,
  imageHosts,
  onEdit,
}: {
  description: string;
  imageHosts: readonly string[];
  onEdit: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [ref, truncated] = useIsTruncated<HTMLDivElement>(description);
  const pencilBeside = useOneLineWithRoom(
    ref,
    description,
    onEdit !== undefined && !expanded && !truncated,
  );
  return (
    <DescriptionSectionView
      description={description}
      imageHosts={imageHosts}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      truncated={truncated}
      bodyRef={ref}
      onEdit={onEdit}
      pencilBeside={pencilBeside}
    />
  );
}

// Whether the text is one line that ends with room for the pencil. Read
// off the text's own boxes, which the pencil laid over them doesn't
// move. Only measured while it could matter (`enabled`).
function useOneLineWithRoom(
  ref: RefObject<HTMLElement | null>,
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
      const doc = el.ownerDocument;
      const words = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = doc.createRange();
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
