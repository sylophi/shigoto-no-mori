// The footer's mirror button on the copy a mirror landed: the same
// spot the remote page's "Mirror here" sits, opening the dialog with
// the running mirror's status, history and controls. Nothing rendered
// on a worktree that is not mirrored, and nothing on the device being
// mirrored FROM either: its header pill names the peer, and the mirror
// is run from that peer.
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { useWorktreeMirror } from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { MirrorManageDialog } from "./MirrorManageDialog";

export function LocalMirrorAction({ worktree }: { worktree: Worktree }) {
  const { session } = useWorktreeMirror(worktree);
  const [open, setOpen] = useState(false);
  const peer = useRemoteDeviceLabel(session?.deviceId ?? "");
  if (session === undefined) return null;
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <RefreshCw />
        Mirror with {peer}
      </Button>
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
