// A peer worktree's ports, from the remote footer's Ports button: the
// same panel the local page shows inline, in the frame the mirror and
// transplant dialogs use, so the three cross-device verbs live in one
// place and look like one family. Forwarding is the app's alone (a
// browser cannot bind a listener). The web client reads the list.
import { Cable } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { TONE_PILL } from "@/components/ui/status-dot";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import {
  FlowHeader,
  TransplantBody,
  TransplantFooter,
} from "../transplant/TransplantChrome";
import { PortsPanel } from "./PortsSection";

export function PortsDialog({
  worktree,
  onClose,
}: {
  worktree: Worktree;
  onClose: () => void;
}) {
  const { deviceId } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  return (
    <ModalShell
      onClose={onClose}
      popoverClassName="flex max-h-[85vh] max-w-2xl flex-col"
    >
      <FlowHeader
        tint={TONE_PILL.sky}
        icon={Cable}
        title={`Ports on ${deviceLabel}`}
        onClose={onClose}
      >
        <p>
          {canForwardPorts
            ? `Switch a port on to reach it at localhost here, at a local port of your choosing.`
            : `What ${deviceLabel} serves from this worktree. Forwarding needs the app.`}
        </p>
      </FlowHeader>
      <TransplantBody>
        <PortsPanel worktree={worktree} />
      </TransplantBody>
      <TransplantFooter
        note={
          canForwardPorts
            ? "A forward stays up until you switch it off or this app quits."
            : "Forwarding needs the app. A browser can only read the list."
        }
      >
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </TransplantFooter>
    </ModalShell>
  );
}
