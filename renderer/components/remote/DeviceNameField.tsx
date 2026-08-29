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

export function DeviceNameField({
  deviceName,
  label,
  editing: controlledEditing,
  onEditingChange,
}: {
  deviceName: string;
  // "This device" / "This browser". The control's accessible name
  // derives from it, so the two can't drift apart.
  label: string;
  // Controlled mode. The registry row keeps its Rename trigger with
  // the row's other actions on the right, where every row's actions
  // live, while the editor itself has to open where the NAME is. Pass
  // both to take the state over; pass neither and the field carries
  // its own trigger inline (the web devices page does).
  editing?: boolean;
  onEditingChange?: (next: boolean) => void;
}) {
  const setDeviceName = useSetDeviceName();
  const [ownEditing, setOwnEditing] = useState(false);
  const controlled = controlledEditing !== undefined;
  const editing = controlled ? controlledEditing : ownEditing;
  const setEditing = (next: boolean): void => {
    if (!controlled) setOwnEditing(next);
    onEditingChange?.(next);
  };
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
    setEditing(false);
  }

  // Enter on an unchanged (or blank) draft is a no-op save, which reads
  // as "close this", not as an error to explain.
  function save(): void {
    if (!canSave) {
      cancel();
      return;
    }
    setDeviceName.mutate(trimmed, { onSuccess: () => setEditing(false) });
  }

  if (!editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-sm font-medium">{deviceName}</span>
        {!controlled && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            aria-label={`Rename ${label.toLowerCase()}`}
            onClick={() => setEditing(true)}
          >
            <Pencil />
            Rename
          </Button>
        )}
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
        className="h-7 w-48 min-w-0 px-2 py-1 text-sm"
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
