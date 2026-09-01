// This device's name, edited in place. The saved name is the metadata
// the credential store keeps, so a rename survives a relaunch. Shared
// by the desktop devices registry ("This device") and the web devices
// page ("This browser"), which differ only in how they address the
// machine -- the rename semantics must not drift between the clients.
//
// The name is TEXT until asked for: it is the thing every other device
// shows in its sidebar, so it reads as an identity, not as a form field
// standing permanently open. Clicking Rename swaps the same line for an
// input, and the two-key contract (Enter saves, Esc reverts) is spelled
// out beside it because an inline editor has no obvious edges.
import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetDeviceName } from "@/hooks/account/useAccount";
import { cn } from "@/lib/utils";

// The trigger is a separate export because its two call sites put it in
// different places: the web page inline after the name, the registry row
// with the row's other actions on the right. The editor itself always
// opens where the NAME is, so the open/closed flag is the caller's to
// hold rather than something the field can own for both layouts.
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
      aria-label={`Rename ${label.toLowerCase()}`}
      onClick={onClick}
    >
      <Pencil />
      Rename
    </Button>
  );
}

export function DeviceNameField({
  deviceName,
  label,
  editing,
  onEditingChange,
  className,
}: {
  deviceName: string;
  // "This device" / "This browser". The control's accessible name
  // derives from it, so the two can't drift apart.
  label: string;
  // Open/closed, held by the caller alongside its DeviceRenameButton.
  editing: boolean;
  onEditingChange: (next: boolean) => void;
  // Type size, honored by the text and by the editor that replaces it,
  // so opening Rename does not make the name jump.
  className?: string;
}) {
  const setDeviceName = useSetDeviceName();
  const [draft, setDraft] = useState(deviceName);

  // Keep the draft in step when the stored name changes underneath us (a
  // broadcast from another window or tab, or the mutation settling).
  useEffect(() => setDraft(deviceName), [deviceName]);

  const trimmed = draft.trim();
  const canSave =
    trimmed.length > 0 && trimmed !== deviceName && !setDeviceName.isPending;

  // Leaving the editor always restores the stored name, so an abandoned
  // draft can never be mistaken for the device's identity next time the
  // editor opens.
  function cancel(): void {
    setDraft(deviceName);
    onEditingChange(false);
  }

  // Enter on an unchanged (or blank) draft is a no-op save, which reads
  // as "close this", not as an error to explain.
  function save(): void {
    if (!canSave) {
      cancel();
      return;
    }
    setDeviceName.mutate(trimmed, { onSuccess: () => onEditingChange(false) });
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
        // The editor only exists because the user just asked for it, so
        // moving the caret here is the whole point of the click.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        type="text"
        value={draft}
        disabled={setDeviceName.isPending}
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
        {setDeviceName.isPending ? "Saving…" : "Save"}
      </Button>
      <Button variant="ghost" size="xs" onClick={cancel}>
        Cancel
      </Button>
      <span className="text-[10px] text-muted-foreground">
        Enter to save, Esc to cancel
      </span>
    </span>
  );
}
