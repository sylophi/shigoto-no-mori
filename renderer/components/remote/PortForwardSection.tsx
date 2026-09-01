// Forward any port from a peer to this machine (v2 step 8, slice B).
// The worktree detail's port row covers the port a worktree already has;
// this is the arbitrary-port arm, and the two share the list and the
// start/stop pair in usePortForwards.
//
// The two halves have DIFFERENT preconditions, which is why the block
// renders on either one alone:
//   - Starting a forward drives a grant-gated verb on the peer, so it
//     needs command access there (`canStart`, resolved for every row at
//     once by the registry rather than per row).
//   - A live forward is a listener on THIS machine. It outlives the peer
//     going to sleep, and stopping it never touches the peer -- so the
//     list stays, with its Stop, even once `canStart` is false. Dropping
//     it there would strand the local port bound until the app quit,
//     with nothing left in the UI to release it.
// Both halves are app-only (the engine binds a real TCP listener in the
// desktop main process, and the web loopback rejects the portForward
// channels); the caller gates that.
import { useState } from "react";
import { Cable, ExternalLink, Loader2, X } from "lucide-react";
import { PortSchema } from "@shared/ipc/modules/portForward";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePortForwards } from "@/hooks/remote/usePortForwards";
import { cn } from "@/lib/utils";

export function PortForwardSection({
  deviceId,
  canStart,
  className,
}: {
  deviceId: string;
  canStart: boolean;
  // The caller's chrome for a block of this kind (the registry row's
  // divider). Applied HERE rather than by a wrapper element so that a
  // section which renders nothing leaves no rule behind either.
  className?: string;
}) {
  const [port, setPort] = useState("");
  const { forwards, start, stop } = usePortForwards(deviceId);
  // Nothing to offer and nothing to release: stay out of the card.
  if (!canStart && forwards.length === 0) return null;
  const parsedPort = parsePort(port);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
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
      {canStart && (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsedPort !== undefined) {
              // Clearing the field is this form's business, not the
              // shared mutation's.
              start.mutate(parsedPort, { onSuccess: () => setPort("") });
            }
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
      )}
    </div>
  );
}

function parsePort(raw: string): number | undefined {
  const parsed = PortSchema.safeParse(Number(raw));
  return parsed.success ? parsed.data : undefined;
}
