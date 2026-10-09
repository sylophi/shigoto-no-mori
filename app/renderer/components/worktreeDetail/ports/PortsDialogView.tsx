// The Ports dialog's content (PortsDialog puts it in a ModalShell): a
// worktree's ports, reached from the Live page.
import type { ReactNode } from "react";
import { Cable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TONE_PILL } from "@/components/ui/status-dot";
import {
  FlowBodyView,
  FlowFooterView,
  FlowHeaderView,
} from "../flow/FlowChromeView";

export function PortsDialogView({
  remote,
  deviceLabel,
  canForward,
  list,
  actions,
  onClose,
}: {
  // A peer's worktree, by its device's name.
  remote: boolean;
  deviceLabel: string;
  // This client can forward a peer's ports (the app, not a browser).
  canForward: boolean;
  // The list (PortList) and its actions (PortActions).
  list: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <FlowHeaderView
        tint={TONE_PILL.sky}
        icon={Cable}
        title={remote ? `Ports on ${deviceLabel}` : "Ports"}
        onClose={onClose}
      >
        <p>
          {remote
            ? canForward
              ? "Switch a port on to reach it at localhost here, at a local port of your choosing. A forward stays on while its server is down."
              : `What ${deviceLabel} serves from this worktree. Forwarding needs the app.`
            : "What this worktree serves."}
        </p>
      </FlowHeaderView>
      <FlowBodyView>{list}</FlowBodyView>
      <FlowFooterView>
        {actions}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </FlowFooterView>
    </>
  );
}
