// A device's name as its registry row draws it (DeviceNameField saves
// it): text until asked for, then the same line as an input with the
// two-key contract (Enter saves, Esc reverts) spelled out beside it,
// because an inline editor has no obvious edges.
import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The trigger is a separate export because it sits apart from the
// field: the registry row keeps it with the row's other actions on the
// right, while the editor always opens where the NAME is, so the
// open/closed flag is the caller's to hold.
export function DeviceRenameButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      aria-label={`Rename ${label}`}
      onClick={onClick}
    >
      <Pencil />
      Rename
    </Button>
  );
}

export function DeviceNameFieldView({
  deviceName,
  label,
  editing,
  onEditingChange,
  className,
  pending = false,
  onSave,
}: {
  deviceName: string;
  // "This device" / "This browser", or the peer's name. The control's
  // accessible name derives from it, so the two can't drift apart.
  label: string;
  // Open/closed, held by the caller alongside its DeviceRenameButton.
  editing: boolean;
  onEditingChange?: (next: boolean) => void;
  // Type size, honored by the text and by the editor that replaces it,
  // so opening Rename does not make the name jump.
  className?: string;
  // A save already on its way.
  pending?: boolean;
  // Store the new name, calling `onSaved` once it lands.
  onSave?: (name: string, onSaved: () => void) => void;
}) {
  const [draft, setDraft] = useState(deviceName);

  // Keep the draft in step when the stored name changes underneath us (a
  // broadcast from another window or tab, or the mutation settling).
  useEffect(() => setDraft(deviceName), [deviceName]);

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== deviceName && !pending;

  // Leaving the editor always restores the stored name, so an abandoned
  // draft can never be mistaken for the device's identity next time the
  // editor opens.
  function cancel(): void {
    setDraft(deviceName);
    onEditingChange?.(false);
  }

  // Enter on an unchanged (or blank) draft is a no-op save, which reads
  // as "close this", not as an error to explain.
  function save(): void {
    if (!canSave) {
      cancel();
      return;
    }
    onSave?.(trimmed, () => onEditingChange?.(false));
  }

  if (!editing) {
    return (
      <span className={cn("truncate text-sm font-medium", className)}>
        {deviceName}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
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
      <span className="text-3xs text-muted-foreground">
        Enter to save, Esc to cancel
      </span>
    </span>
  );
}
