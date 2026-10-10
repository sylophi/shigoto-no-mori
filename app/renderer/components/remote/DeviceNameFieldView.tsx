// A device's name, edited in place on its registry row, this device's
// or a peer's. The name lives on the device hub (shared/account/
// enroll.ts updateDevice), so a rename reaches a peer that is offline
// too, and it takes the new name on its next registry read. Shared by
// the desktop app ("This device") and the web client ("This browser"),
// which differ only in how they address this machine -- the rename
// semantics must not drift between the clients.
//
// The name is TEXT until asked for: it is the thing every other device
// shows in its sidebar, so it reads as an identity, not as a form field
// standing permanently open. Clicking Rename swaps the same line for the
// inline editor (InlineNameEditorView).
import { Pencil } from "lucide-react";
import { InlineNameEditorView } from "@shigomori/ui/views/shared/InlineNameEditorView.tsx";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

// The trigger is a separate export because it sits apart from the
// field: the registry row keeps it with the row's other actions on the
// right, while the editor always opens where the NAME is, so the
// open/closed flag is the caller's to hold.
export function DeviceRenameButtonView({
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
  pending,
  onRename,
  className,
}: {
  deviceName: string;
  // "This device" / "This browser", or the peer's name. The control's
  // accessible name derives from it, so the two can't drift apart.
  label: string;
  // Open/closed, held by the caller alongside its DeviceRenameButton.
  editing: boolean;
  onEditingChange: (next: boolean) => void;
  pending: boolean;
  // Saves the new name, closing the editor once it lands.
  onRename: (name: string) => void;
  // Type size, honored by the text and by the editor that replaces it,
  // so opening Rename does not make the name jump.
  className?: string;
}) {
  if (!editing) {
    return (
      <span className={cn("truncate text-sm font-medium", className)}>
        {deviceName}
      </span>
    );
  }
  return (
    <InlineNameEditorView
      name={deviceName}
      label={label}
      pending={pending}
      onSave={onRename}
      onCancel={() => onEditingChange(false)}
      className={className}
    />
  );
}
