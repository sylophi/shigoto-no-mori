// Forward a port from the remote device to this machine (v2 step 8,
// slice B): a slim section under the forest's project groups.
// Granted-only (the engine drives grant-gated forward verbs on the
// host) and app-only (the parent gates the mount on
// window.api.isElectron: the engine binds a real TCP listener in the
// desktop's main process, and the web loopback rejects the portForward
// channels). Everything here is CLIENT-scoped and calls window.api
// directly, never the surrounding host scope: the listener belongs to
// this machine, only its target is the scoped device. The list caches
// under one client key for all devices, and this section filters to
// its own.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, ExternalLink, Loader2, X } from "lucide-react";
import { PortSchema } from "@shared/ipc/modules/portForward";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";

export function PortForwardSection() {
  const { deviceId } = useHostScope();
  const { granted } = useCommandAccess();
  const queryClient = useQueryClient();
  const [port, setPort] = useState("");
  const { data } = useQuery({
    queryKey: queryKeys.portForwards(),
    queryFn: () => window.api.portForward.list(),
    meta: { silentError: true },
  });
  // The engine broadcasts on every forward/conn change, so conn counts
  // and engine-side teardowns (peer offline) render live. It also fires
  // for this section's own mutations, so they never invalidate the list
  // themselves (the broadcast-owns-invalidation rule, see
  // renderer/hooks/account/useAccount.ts).
  useEffect(
    () =>
      window.api.portForward.onChanged(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.portForwards(),
        });
      }),
    [queryClient],
  );
  const start = useMutation({
    mutationFn: (remotePort: number) =>
      window.api.portForward.start({ deviceId, remotePort }),
    onSuccess: () => setPort(""),
    // The engine's start probe surfaces the coded errors here
    // (connect-failed, too-many-conns). Refusals surface centrally.
    onError: (err) => {
      if (!isCommandRefusedError(err)) {
        notifyError("Couldn't forward the port", err);
      }
    },
    meta: { silentError: true },
  });
  const stop = useMutation({
    mutationFn: (forwardId: string) => window.api.portForward.stop(forwardId),
    onError: (err) => {
      if (!isCommandRefusedError(err)) {
        notifyError("Couldn't stop forwarding", err);
      }
    },
    meta: { silentError: true },
  });
  if (!granted) return null;
  const forwards = (data?.forwards ?? []).filter(
    (forward) => forward.deviceId === deviceId,
  );
  const parsedPort = parsePort(port);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Cable className="size-3.5 shrink-0" />
        <span>Port forwarding</span>
      </div>
      {forwards.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {forwards.map((forward) => (
            <div
              key={forward.forwardId}
              className="flex items-center gap-2 px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                localhost:{forward.localPort} {"->"} {forward.remotePort}
              </span>
              {forward.connCount > 0 && (
                <span className="tabular shrink-0 text-[10px] text-muted-foreground/70">
                  {forward.connCount}
                </span>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Open in browser"
                onClick={() =>
                  void window.api.shell.openExternal(
                    `http://localhost:${forward.localPort}`,
                  )
                }
              >
                <ExternalLink />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Stop forwarding"
                disabled={stop.isPending}
                onClick={() => stop.mutate(forward.forwardId)}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsedPort !== undefined) start.mutate(parsedPort);
        }}
      >
        <Input
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(event) => setPort(event.target.value)}
          placeholder="Remote port"
          aria-label="Remote port to forward"
          className="h-6 w-28 px-2 text-xs"
        />
        <Button
          type="submit"
          size="xs"
          variant="secondary"
          disabled={start.isPending || parsedPort === undefined}
        >
          {start.isPending ? <Loader2 className="animate-spin" /> : "Forward"}
        </Button>
      </form>
    </div>
  );
}

function parsePort(raw: string): number | undefined {
  const parsed = PortSchema.safeParse(Number(raw));
  return parsed.success ? parsed.data : undefined;
}
