import type { ReactNode } from "react";
import { PAGE_BODY } from "../shared/PageShellView.tsx";
import { LoadFailure } from "../../primitives/load-failure.tsx";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";

// The "All devices" tab's sections, the project's shared settings.
export function ConfigureSharedView({ children }: { children: ReactNode }) {
  return (
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-10">{children}</div>
    </div>
  );
}

// The switch that keeps the project's settings the same on every
// device. While it is on, the device tabs give way to one form.
export function SyncSettingsSectionView({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <section>
      <ToggleRowView
        checked={checked}
        onCheckedChange={onCheckedChange}
        label="Sync settings across devices"
        description="Turning it on gives the other devices this one's settings."
      />
    </section>
  );
}

// A device's project file that would not load.
export function ConfigureLoadFailureView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="p-6 phone:p-4">
      <LoadFailure message={message} onRetry={onRetry} />
    </div>
  );
}
