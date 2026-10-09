import type { ReactNode } from "react";
import { CenteredMessage } from "@/components/ui/centered-message";

// What a device's pages show while its sharing switch is off: there is
// nothing of it to show.
export function NotSharingView({
  label,
  action,
}: {
  label: string;
  // Where to go instead.
  action: ReactNode;
}) {
  return (
    <CenteredMessage className="flex-col gap-3">
      {`${label} isn't sharing with other devices.`}
      {action}
    </CenteredMessage>
  );
}
