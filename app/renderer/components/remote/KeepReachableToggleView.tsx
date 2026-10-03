// The "Keep this device reachable" switch's look (KeepReachableToggle
// reads and writes it).
import { ToggleRow } from "@/components/shared/ToggleRow";

export function KeepReachableToggleView({
  checked,
  pending = false,
  launchAtLoginSupported,
  onChange,
}: {
  checked: boolean;
  // A write already on its way.
  pending?: boolean;
  // Whether this platform can start the app at login, which decides
  // what the switch promises.
  launchAtLoginSupported: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <ToggleRow
      checked={checked}
      onCheckedChange={(next) => onChange?.(next)}
      disabled={pending}
      label="Keep this device reachable"
      description={
        launchAtLoginSupported
          ? "Starts Shigoto no Mori when you log in and relaunches it after a recoverable crash, so this machine stays available to your account."
          : "Relaunches Shigoto no Mori after a recoverable crash so this machine stays available to your account. Starting automatically at login isn't supported on this platform."
      }
    />
  );
}
