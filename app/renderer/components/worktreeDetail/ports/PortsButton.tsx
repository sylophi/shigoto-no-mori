// The footer's Ports button, the same spot on the local and the remote
// worktree page, so the footer's verbs sit in one place. Opens the
// Ports dialog. Always there: reading the list needs no grant, and a
// worktree with no ports says so in the dialog.
import { useState } from "react";
import { Cable } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { FooterActionButton } from "../FooterActionButton";
import { LABEL_RANK } from "../footerFit";
import { PortsDialog } from "./PortsDialog";

export function PortsButton({ worktree }: { worktree: Worktree }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FooterActionButton
        rank={LABEL_RANK.ports}
        icon={<Cable />}
        label="Ports"
        title="See this worktree's ports"
        onClick={() => setOpen(true)}
      />
      {open && (
        <PortsDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
