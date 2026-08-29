// The worktree's port, where it actually is. Locally that is one quiet
// row: the port-pool port and an open-in-browser affordance. Under a
// remote scope the row becomes the forward control: forward the port to
// this machine's localhost over the device connection (app-only — a
// browser cannot bind a listener) and open the LOCAL end. Renders
// nothing when the worktree has no known port, so the section costs
// nothing on repos without port-pool.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, ExternalLink, Loader2, X } from "lucide-react";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type { Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId, queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";

export function PortsSection({ worktree }: { worktree: Worktree }) {
  const { deviceId } = useHostScope();
  const remote = deviceId !== localDeviceId;
  if (worktree.port === undefined) return null;
  // Forwarding binds a real local listener; only the app can.
  if (remote && !window.api.isElectron) return null;
  return (
    <section className="space-y-3">
      <SectionHeading>Ports</SectionHeading>
      {remote ? (
        <RemotePortRow port={worktree.port} deviceId={deviceId} />
      ) : (
        <LocalPortRow port={worktree.port} />
      )}
    </section>
  );
}

function LocalPortRow({ port }: { port: number }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-xs">
      <span className="font-mono">{port}</span>
      <span className="text-muted-foreground">from port-pool</span>
      <Button
        variant="ghost"
        size="xs"
        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() =>
          void window.api.shell.openExternal(`http://localhost:${port}`)
        }
      >
        <ExternalLink />
        Open in browser
      </Button>
    </div>
  );
}

function RemotePortRow({ port, deviceId }: { port: number; deviceId: string }) {
  const { granted } = useCommandAccess();
  const queryClient = useQueryClient();
  const deviceLabel =
    useRemoteDevices().find((entry) => entry.deviceId === deviceId)?.label ??
    "the device";
  const { data } = useQuery({
    queryKey: queryKeys.portForwards(),
    queryFn: () => window.api.portForward.list(),
    meta: { silentError: true },
  });
  // The engine broadcasts on every forward/conn change; the list never
  // invalidates itself (broadcast-owns-invalidation, same as the
  // forest's PortForwardSection).
  useEffect(
    () =>
      window.api.portForward.onChanged(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.portForwards(),
        });
      }),
    [queryClient],
  );
  const forward = (data?.forwards ?? []).find(
    (entry) => entry.deviceId === deviceId && entry.remotePort === port,
  );
  const start = useMutation({
    mutationFn: () =>
      window.api.portForward.start({ deviceId, remotePort: port }),
    onError: (err) => {
      if (!isCommandRefusedError(err)) {
        notifyError("Couldn't forward the port", err);
      }
    },
    meta: { silentError: true },
  });
  const stop = useMutation({
    mutationFn: (forwardId: string) => window.api.portForward.stop(forwardId),
    onError: (err) => notifyError("Couldn't stop the forward", err),
    meta: { silentError: true },
  });

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-xs">
      <span className="font-mono">{port}</span>
      {forward !== undefined ? (
        <span className="font-mono text-muted-foreground">
          localhost:{forward.localPort} ⇄ {deviceLabel}:{port}
        </span>
      ) : (
        <span className="text-muted-foreground">on {deviceLabel}</span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {forward !== undefined ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                void window.api.shell.openExternal(
                  `http://localhost:${forward.localPort}`,
                )
              }
            >
              <ExternalLink />
              Open in browser
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-foreground"
              disabled={stop.isPending}
              onClick={() => stop.mutate(forward.forwardId)}
            >
              <X />
              Stop forward
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            disabled={!granted || start.isPending}
            title={
              granted
                ? `Forward ${deviceLabel}:${port} to this machine's localhost`
                : "Needs command access, granted from that device's Devices page"
            }
            onClick={() => start.mutate()}
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <Cable />}
            Forward to localhost
          </Button>
        )}
      </div>
    </div>
  );
}
