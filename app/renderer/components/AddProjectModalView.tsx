import type { ReactNode } from "react";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { SegmentedControl } from "@/components/ui/segmented-control";

export type AddProjectMode = "existing" | "clone" | "create";

const MODE_OPTIONS = [
  { value: "existing", label: "Add existing" },
  { value: "clone", label: "Clone" },
  { value: "create", label: "Create new" },
] as const;

// The add-project dialog's head: how to add it, and on which device.
export function AddProjectHeaderView({
  mode,
  onMode,
  tabs,
}: {
  mode: AddProjectMode;
  onMode: (mode: AddProjectMode) => void;
  // The device tab bar, when there is a pick.
  tabs: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-2">
      <SegmentedControl
        value={mode}
        onChange={onMode}
        options={MODE_OPTIONS}
        aria-label="How to add the project"
        className="mx-3 self-start"
      />
      {tabs}
    </div>
  );
}

// No device that holds projects to add one to.
export function AddProjectNoDeviceView({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="p-6">
      <EmptyPanel>
        {signedIn
          ? "No device that holds projects is signed in to this account."
          : "Sign in to add a project from one of the account's devices."}
      </EmptyPanel>
    </div>
  );
}
