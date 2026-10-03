// A peer's port forwards as its registry row draws them
// (PortForwardSection runs them): a chip per live forward that opens in
// the browser, with its own Stop, and one quiet "Forward a port" chip
// that unfolds into the port field only when asked.
import { useState } from "react";
import {
  Cable,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import { parsePortNumber } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { Chip, ChipButton } from "@/components/ui/chip-button";
import { ExternalLink } from "@/components/ui/external-link";
import { Input } from "@/components/ui/input";

export function PortForwardSectionView({
  forwards,
  canStart,
  startPending = false,
  stopPending = false,
  onStart,
  onStop,
}: {
  // The live forwards to this peer.
  forwards: readonly Pick<
    PortForwardSummary,
    "forwardId" | "remotePort" | "localPort" | "connCount"
  >[];
  // The peer accepts a new forward (PortForwardSection).
  canStart: boolean;
  // A start or a stop already on its way.
  startPending?: boolean;
  stopPending?: boolean;
  // Forward the peer's port, calling `onStarted` once it is up.
  onStart?: (remotePort: number, onStarted: () => void) => void;
  onStop?: (forwardId: string) => void;
}) {
  const [port, setPort] = useState("");
  const [adding, setAdding] = useState(false);
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
              className="tabular ml-1 text-3xs text-muted-foreground/70"
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
            disabled={stopPending}
            onClick={() => onStop?.(forward.forwardId)}
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
                onStart?.(parsedPort, close);
              }
            }}
          >
            <Input
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field only exists because the user just asked for it, so moving the caret here is the point of the click
              autoFocus
              type="number"
              disabled={startPending}
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              onKeyDown={(event) => {
                // Cancel is disabled while the start is in flight, and
                // Escape follows it: folding mid-flight would let the
                // success handler close a field the user had reopened.
                if (event.key === "Escape" && !startPending) {
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
              disabled={startPending || parsedPort === undefined}
            >
              {startPending ? <Loader2 className="animate-spin" /> : "Forward"}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={startPending}
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
