// The project menu's Add to device, once a device is picked: where the
// clone lands there, and the way to put it somewhere else
// (AddToDeviceDialog binds it).
import { KEYS } from "../../lib/keys.ts";
import type { ReactNode } from "react";
import { Button } from "../../primitives/button.tsx";
import { DialogFrame } from "../../primitives/dialog.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { DestinationRowView } from "../addProject/DialogPartsView.tsx";
import type { CloneDestination } from "../worktreeDetail/flow/pullSteps.ts";

export function AddToDeviceDialogView({
  title,
  clone,
  onChangeParent,
  picker,
  onAdd,
  onCancel,
}: {
  title: string;
  clone: CloneDestination;
  onChangeParent: () => void;
  // The folder picker, while it is open.
  picker: ReactNode;
  onAdd: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <DialogFrame
        title={
          <SimpleTooltip whenTruncated tip={title}>
            <span className="block truncate">{title}</span>
          </SimpleTooltip>
        }
        onCancel={onCancel}
        onSubmit={onAdd}
        actions={
          <Button
            type="submit"
            keys={KEYS.enter}
            size="sm"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- ↩ adds, as the button's hint says
            autoFocus
            disabled={!clone.ready || clone.found === "taken"}
          >
            Add
          </Button>
        }
      >
        <div className="mt-4 flex flex-col gap-2 text-sm">
          <DestinationRowView
            dest={clone.dest}
            onChangeParent={onChangeParent}
          />
          {clone.found === "same-repo" && (
            <p className="text-xs text-muted-foreground">
              A checkout of {clone.projectName} is already there, so it&apos;s
              added as it is.
            </p>
          )}
          {clone.found === "taken" && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Something other than a checkout of {clone.projectName} is there.
            </p>
          )}
        </div>
      </DialogFrame>
      {picker}
    </>
  );
}
