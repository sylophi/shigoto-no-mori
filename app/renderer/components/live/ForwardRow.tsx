// The Live page's port forwards: every listener this machine holds
// against a peer's port. A forward is this machine's alone (the engine
// binds it here), so its stop never needs the peer.
import { Cable, ExternalLink as ExternalLinkIcon, X } from "lucide-react";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { pluralize } from "@/lib/pluralize";
import { DeviceRef, LiveRow, Sep, WorktreeRef } from "./LiveRow";

export function ForwardRow({
  forward,
  stopping,
  onStop,
}: {
  forward: PortForwardSummary;
  stopping: boolean;
  onStop: () => void;
}) {
  const api = useRemoteDeviceApi(forward.deviceId);
  return (
    <LiveRow
      lead={<Cable aria-hidden className="size-3.5 text-muted-foreground" />}
      title={
        <ExternalLink
          href={`http://localhost:${forward.localPort}`}
          errorTitle="Couldn't open the forwarded port"
          className="inline-flex min-w-0 items-center gap-1 font-mono font-medium no-underline hover:underline"
        >
          localhost:{forward.localPort}
          <ExternalLinkIcon
            aria-hidden
            className="size-3 text-muted-foreground/60"
          />
        </ExternalLink>
      }
      detail={
        <>
          <span className="shrink-0">port {forward.remotePort} on</span>
          <DeviceRef deviceId={forward.deviceId} />
          {forward.worktree && (
            <>
              <Sep />
              <WorktreeRef
                deviceId={forward.deviceId}
                api={api}
                projectId={forward.worktree.projectId}
                worktreeId={forward.worktree.worktreeId}
              />
            </>
          )}
          {forward.connCount > 0 && (
            <>
              <Sep />
              <span className="tabular shrink-0">
                {pluralize(forward.connCount, "open connection")}
              </span>
            </>
          )}
        </>
      }
      actions={
        <Button
          size="xs"
          variant="outline-destructive"
          aria-label={`Stop forwarding port ${forward.remotePort}`}
          disabled={stopping}
          onClick={onStop}
        >
          <X />
          Stop
        </Button>
      }
    />
  );
}
