// Forward any port from a peer to this machine (v2 step 8, slice B).
// The worktree detail's port row covers the port a worktree already
// has. This is the arbitrary-port arm, and the two share the list and
// the start/stop pair in usePortForwards.
//
// Drawn as a strip of chips under the device, like the Launch chips on
// a worktree page: each live forward is a chip that opens in the
// browser, with its own Stop, and one quiet "Forward a port" chip
// unfolds into the port field only when asked. Nothing here is a form
// until the user wants one.
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
// Both halves are app-only, since the engine binds a real TCP listener
// in the desktop main process and the web loopback rejects the
// portForward channels. The caller gates that.
import { useState } from "react";
import {
  Cable,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { parsePortNumber } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { Chip, ChipButton } from "@/components/ui/chip-button";
import { ExternalLink } from "@/components/ui/external-link";
import { Input } from "@/components/ui/input";
import { usePortForwards } from "@/hooks/remote/usePortForwards";

export function PortForwardSection({
  deviceId,
  canStart,
}: {
  deviceId: string;
  canStart: boolean;
}) {
  const [port, setPort] = useState("");
  const [adding, setAdding] = useState(false);
  const { forwards, start, stop } = usePortForwards(deviceId);
  const parsedPort = parsePortNumber(port);

  // Folding the field away always drops the draft: a half-typed port
  // has no meaning once the chip is back.
  function close(): void {
    setAdding(false);
    setPort("");
  }

  // The peer withdrawing the grant hides the field, and the draft goes with
  // it, so a later re-grant does not reopen a stale field and steal
  // focus. Reset during render, the shape React documents for state
  // that depends on a prop.
  if (!canStart && (adding || port !== "")) close();

  // Nothing to offer and nothing to release: stay out of the row.
  if (!canStart && forwards.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Cable
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/50"
      />
      <span className="sr-only">Port forwards</span>
      {forwards.map((forward) => (
        <Chip key={forward.forwardId} className="gap-0.5 pr-0.5">
          <ExternalLink
            href={`http://localhost:${forward.localPort}`}
            errorTitle="Couldn't open the forwarded port"
            className="inline-flex items-center gap-1 font-mono no-underline hover:underline"
          >
            localhost:{forward.localPort}
            <span aria-hidden className="text-muted-foreground/60">
              →
            </span>
            {forward.remotePort}
            <ExternalLinkIcon
              aria-hidden
              className="size-3 text-muted-foreground/60"
            />
          </ExternalLink>
          {forward.connCount > 0 && (
            <span
              className="tabular ml-1 text-[10px] text-muted-foreground/70"
              title={`${forward.connCount} open ${forward.connCount === 1 ? "connection" : "connections"}`}
            >
              {forward.connCount}
            </span>
          )}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Stop forwarding port ${forward.remotePort}`}
            className="size-5 text-muted-foreground"
            disabled={stop.isPending}
            onClick={() => stop.mutate(forward.forwardId)}
          >
            <X />
          </Button>
        </Chip>
      ))}
      {canStart &&
        (adding ? (
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (parsedPort !== undefined) {
                // Folding the field is this form's business, not the
                // shared mutation's.
                start.mutate({ remotePort: parsedPort }, { onSuccess: close });
              }
            }}
          >
            <Input
              // The field only exists because the user just asked for
              // it, so moving the caret here is the point of the click.
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              type="number"
              disabled={start.isPending}
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              onKeyDown={(event) => {
                // Cancel is disabled while the start is in flight, and
                // Escape follows it: folding mid-flight would let the
                // success handler close a field the user had reopened.
                if (event.key === "Escape" && !start.isPending) {
                  event.preventDefault();
                  close();
                }
              }}
              placeholder="Remote port"
              aria-label="Remote port to forward"
              // The spinner is noise on a chip strip. Typing the port is
              // the only sensible way to enter one.
              className="h-6 w-28 [appearance:textfield] px-2 text-xs [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <Button
              type="submit"
              size="xs"
              variant="secondary"
              disabled={start.isPending || parsedPort === undefined}
            >
              {start.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                "Forward"
              )}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={start.isPending}
              onClick={close}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <ChipButton onClick={() => setAdding(true)}>
            <Plus aria-hidden className="size-3" />
            Forward a port
          </ChipButton>
        ))}
    </div>
  );
}
