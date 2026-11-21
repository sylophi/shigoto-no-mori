import type { ReactNode } from "react";
import { EmptyPanel } from "../primitives/empty-panel.tsx";
import { SegmentedControl } from "../primitives/segmented-control.tsx";
import { cn } from "../lib/utils.ts";

export type AddProjectMode = "existing" | "clone" | "create";

const MODE_OPTIONS = [
  { value: "existing", label: "Add existing" },
  { value: "clone", label: "Clone" },
  { value: "create", label: "Create new" },
] as const;

// The add-project dialog's head: how to add it, on which device, and
// whether terrier lists it too. Held still while a clone or a new
// repository is under way.
export function AddProjectHeaderView({
  mode,
  onMode,
  tabs,
  terrierOptIn,
  working = false,
}: {
  mode: AddProjectMode;
  onMode: (mode: AddProjectMode) => void;
  // The device tab bar, when there is a pick.
  tabs: ReactNode;
  // The terrier box, where the device offers it.
  terrierOptIn: ReactNode;
  working?: boolean;
}) {
  return (
    <div
      inert={working}
      className={cn(
        "flex flex-col gap-2 border-b border-border py-2",
        working && "opacity-50",
      )}
    >
      <div className="mx-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <SegmentedControl
          value={mode}
          onChange={onMode}
          options={MODE_OPTIONS}
          aria-label="How to add the project"
        />
        {terrierOptIn}
      </div>
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
