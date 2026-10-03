// The footer's Ports button, the same spot on the local and the remote
// worktree page, so the footer's verbs sit in one place. Opens the
// Ports dialog. Always there: reading the list needs no grant, and a
// worktree with no ports says so in the dialog. On a peer's worktree
// whose ports this machine forwards, the glyph takes the live tone,
// which still shows once the label folds, and the title lists them.
import { useState } from "react";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";
import { FooterLeadingVerbView } from "../FooterLeadingVerbView";
import { PortsDialog } from "./PortsDialog";

export function PortsButton({ worktree }: { worktree: Worktree }) {
  const [open, setOpen] = useState(false);
  // Forwards only ever reach peers, so on this machine's own page the
  // tip simply stays undefined.
  const { deviceId } = useHostScope();
  const forwardTip = useWorktreeForwardTip(deviceId, worktree);
  return (
    <>
      <FooterLeadingVerbView
        verb={{ kind: "ports", forwardTip }}
        onClick={() => setOpen(true)}
      />
      {open && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
