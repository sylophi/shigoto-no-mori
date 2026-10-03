// The footer's Ports button, the same spot on the local and the remote
// worktree page, so the footer's verbs sit in one place. Opens the
// Ports dialog. Always there: reading the list needs no grant, and a
// worktree with no ports says so in the dialog. On a peer's worktree
// whose ports this machine forwards, the glyph takes the live tone,
// which still shows once the label folds, and the title lists them.
import { useState } from "react";
import { Cable } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { TONE_TEXT } from "@/components/ui/status-dot";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";
import { FooterActionButton } from "../FooterActionButton";
import { LABEL_RANK } from "../footerFit";
import { PortsDialog } from "./PortsDialog";

export function PortsButton({ worktree }: { worktree: Worktree }) {
  const [open, setOpen] = useState(false);
  // Forwards only ever reach peers, so on this machine's own page the
  // tip simply stays undefined.
  const { deviceId } = useHostScope();
  const forwardTip = useWorktreeForwardTip(deviceId, worktree);
  return (
    <>
      <FooterActionButton
        rank={LABEL_RANK.ports}
        icon={
          <Cable
            className={forwardTip !== undefined ? TONE_TEXT.emerald : undefined}
          />
        }
        label="Ports"
        title={forwardTip ?? "See this worktree's ports"}
        onClick={() => setOpen(true)}
      />
      {open && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
