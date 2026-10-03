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
// standing permanently open. Clicking Rename swaps the same line for an
// input (DeviceNameFieldView draws both).
import { useSetDeviceName } from "@/hooks/account/useAccount";
import { DeviceNameFieldView } from "./DeviceNameFieldView";

export function DeviceNameField({
  deviceId,
  deviceName,
  label,
  editing,
  onEditingChange,
  className,
}: {
  deviceId: string;
  deviceName: string;
  // "This device" / "This browser", or the peer's name. The control's
  // accessible name derives from it, so the two can't drift apart.
  label: string;
  // Open/closed, held by the caller alongside its DeviceRenameButton.
  editing: boolean;
  onEditingChange: (next: boolean) => void;
  // Type size, honored by the text and by the editor that replaces it,
  // so opening Rename does not make the name jump.
  className?: string;
}) {
  const setDeviceName = useSetDeviceName();
  return (
    <DeviceNameFieldView
      deviceName={deviceName}
      label={label}
      editing={editing}
      onEditingChange={onEditingChange}
      className={className}
      pending={setDeviceName.isPending}
      onSave={(name, onSaved) =>
        setDeviceName.mutate({ deviceId, name }, { onSuccess: onSaved })
      }
    />
  );
}
