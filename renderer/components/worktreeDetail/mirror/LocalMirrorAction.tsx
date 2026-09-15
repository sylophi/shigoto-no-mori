// The footer's mirror button on the copy a mirror landed: the same
// spot the remote page's "Mirror here" sits, opening the dialog with
// the running mirror's status, history and controls. Nothing rendered
// on a worktree that is not mirrored, and nothing on the device being
// mirrored FROM either: its header pill names the peer, and the mirror
// is run from that peer.
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { useWorktreeMirror } from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { FooterActionButton } from "../FooterActionButton";
import { MirrorManageDialog } from "./MirrorManageDialog";

export function LocalMirrorAction({ worktree }: { worktree: Worktree }) {
  const { session } = useWorktreeMirror(worktree);
  const [open, setOpen] = useState(false);
  const peer = useRemoteDeviceLabel(session?.deviceId ?? "");
  if (session === undefined) return null;
  return (
    <>
      <FooterActionButton
        icon={<RefreshCw />}
        label={`Mirror with ${peer}`}
        onClick={() => setOpen(true)}
      />
      {open && (
        <MirrorManageDialog
          session={session}
          worktree={worktree}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
