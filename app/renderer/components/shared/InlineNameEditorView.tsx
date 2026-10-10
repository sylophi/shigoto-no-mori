// A name edited in place: the line that showed the name turns into an
// input, Enter saves and Esc reverts, and the two-key contract is
// spelled out beside it because an inline editor has no obvious edges.
// A device's name (DeviceNameFieldView) and a worktree's folder
// (WorktreeLocationView) are renamed with it.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function InlineNameEditorView({
  name,
  label,
  pending,
  onSave,
  onCancel,
  className,
}: {
  // The stored name, the draft's start.
  name: string;
  // What is named, for the input's accessible name.
  label: string;
  pending: boolean;
  // Saves a changed, non-blank name.
  onSave: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(name);

  // Keep the draft in step when the stored name changes underneath us (a
  // broadcast from another window or tab, or the mutation settling).
  useEffect(() => setDraft(name), [name]);

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== name && !pending;

  // Leaving the editor always restores the stored name, so an abandoned
  // draft is never mistaken for the name next time the editor opens.
  function cancel(): void {
    setDraft(name);
    onCancel();
  }

  // Enter on an unchanged (or blank) draft is a no-op save, which reads
  // as "close this", not as an error to explain.
  function save(): void {
    if (!canSave) {
      cancel();
      return;
    }
    onSave(trimmed);
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {/* The hint is what wraps when room runs out. */}
      <span className="flex min-w-0 items-center gap-1.5">
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the editor only exists because the user just asked for it, so moving the caret here is the whole point of the click
          autoFocus
          type="text"
          value={draft}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          aria-label={`${label} name`}
          className={cn("h-7 w-48 min-w-0 px-2 py-1 text-sm", className)}
        />
        <Button variant="outline" size="xs" disabled={!canSave} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="xs" onClick={cancel}>
          Cancel
        </Button>
      </span>
      <span className="text-3xs text-muted-foreground">
        Enter to save, Esc to cancel
      </span>
    </span>
  );
}
