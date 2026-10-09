import { useSetDeviceName } from "@/hooks/account/useAccount";
import { DeviceNameFieldView } from "./DeviceNameFieldView";

// A device's name field (DeviceNameFieldView), its rename written to
// the device hub.
export function DeviceNameField({
  deviceId,
  onEditingChange,
  ...props
}: {
  deviceId: string;
  deviceName: string;
  label: string;
  editing: boolean;
  onEditingChange: (next: boolean) => void;
  className?: string;
}) {
  const setDeviceName = useSetDeviceName();
  return (
    <DeviceNameFieldView
      {...props}
      onEditingChange={onEditingChange}
      pending={setDeviceName.isPending}
      onRename={(name) =>
        setDeviceName.mutate(
          { deviceId, name },
          { onSuccess: () => onEditingChange(false) },
        )
      }
    />
  );
}
