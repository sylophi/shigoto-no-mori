// A worktree's ports in a dialog, for the Live page, which shows many
// worktrees and has no room for every list. The worktree page shows the
// same list in its Ports section (PortsSection). In the frame the
// mirror and transplant dialogs use.
import type { Worktree } from "@shigomori/contracts/schemas";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { PortActions, PortList, usePortList } from "./PortList";
import { PortsDialogView } from "./PortsDialogView";

export function PortsDialog({
  worktree,
  onClose,
}: {
  worktree: Worktree;
  onClose: () => void;
}) {
  const state = usePortList(worktree);
  const { remote, deviceLabel } = state;

  return (
    <ModalShell onClose={onClose} popoverClassName="max-w-2xl">
      <PortsDialogView
        remote={remote}
        deviceLabel={deviceLabel}
        canForward={canForwardPorts}
        list={<PortList state={state} />}
        actions={<PortActions state={state} />}
        onClose={onClose}
      />
    </ModalShell>
  );
}
