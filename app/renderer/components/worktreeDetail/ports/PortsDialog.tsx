// A worktree's ports in a dialog, for the Live page, which shows many
// worktrees and has no room for every list. The worktree page shows the
// same list in its Ports section (PortsSection). In the frame the
// mirror and transplant dialogs use.
import { Cable } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { TONE_PILL } from "@/components/ui/status-dot";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { FlowHeader, FlowBody, FlowFooter } from "../flow/FlowChrome";
import { PortActions, PortList, usePortList } from "./PortList";

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
      <FlowHeader
        tint={TONE_PILL.sky}
        icon={Cable}
        title={remote ? `Ports on ${deviceLabel}` : "Ports"}
        onClose={onClose}
      >
        <p>
          {remote
            ? canForwardPorts
              ? "Switch a port on to reach it at localhost here, at a local port of your choosing. A forward stays on while its server is down."
              : `What ${deviceLabel} serves from this worktree. Forwarding needs the app.`
            : "What this worktree serves."}
        </p>
      </FlowHeader>
      <FlowBody>
        <PortList state={state} />
      </FlowBody>
      <FlowFooter>
        <PortActions state={state} />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </FlowFooter>
    </ModalShell>
  );
}
