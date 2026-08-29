// This device's name, editable inline. The saved name is the metadata
// the credential store keeps, so a rename survives a relaunch. Shared
// by the desktop account section ("This device") and the web devices
// page ("This browser"), which differ only in how they address the
// machine -- the rename semantics must not drift between the clients.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetDeviceName } from "@/hooks/account/useAccount";

export function DeviceNameField({
  deviceName,
  label,
  inputAriaLabel,
}: {
  deviceName: string;
  label: string;
  inputAriaLabel: string;
}) {
  const setDeviceName = useSetDeviceName();
  const [draft, setDraft] = useState(deviceName);

  // Keep the draft in step when the stored name changes underneath us (a
  // broadcast from another window or tab, or the mutation settling).
  useEffect(() => setDraft(deviceName), [deviceName]);

  const trimmed = draft.trim();
  const canSave =
    trimmed.length > 0 && trimmed !== deviceName && !setDeviceName.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted-foreground" htmlFor="device-name">
        {label}
      </label>
      <Input
        id="device-name"
        type="text"
        value={draft}
        disabled={setDeviceName.isPending}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={inputAriaLabel}
        className="min-w-0 flex-1 px-2.5 py-1.5 text-sm"
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!canSave}
        onClick={() => setDeviceName.mutate(trimmed)}
      >
        Rename
      </Button>
    </div>
  );
}
