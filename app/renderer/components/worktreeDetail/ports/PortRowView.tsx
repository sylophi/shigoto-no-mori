// One port of a worktree, as a small card in two parts. The header
// names it (live dot, label, number, where it came from) and holds the
// row's own actions on the right: Open, and for a custom port, Edit
// and Remove. Under a remote scope a second band carries the forward:
// the `from -> localhost:port` form on the left and the switch on the
// right (ForwardControl, PortRow puts it in). Locally there is nothing
// to forward, so the header is the whole card. `plain` drops the card's
// border and fill, for a page section whose neighbors are plain rows,
// and sets the band in under the label instead.
import { useState, type ReactNode } from "react";
import { Pencil, X } from "lucide-react";
import type { CustomPort, WorktreePort } from "@shigomori/contracts/schemas";
import { Button } from "@/components/ui/button";
import { RowTag } from "@/components/ui/row-tag";
import { StatusDot } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { OpenLocalhostButtonView } from "./OpenLocalhostButtonView";
import { PortFormView } from "./PortFormView";

const SOURCE_LABEL: Record<WorktreePort["source"], string> = {
  pool: "port-pool",
  custom: "custom",
};

export function PortRowView({
  entry,
  taken,
  remote,
  onUpdate,
  onRemove,
  plain = false,
  forward,
}: {
  entry: WorktreePort;
  // Every listed port, for the edit form's duplicate check.
  taken: readonly WorktreePort[];
  remote: boolean;
  // Present only when this row may be changed (a custom entry, and the
  // viewer holds command access on the host).
  onUpdate?: (next: CustomPort) => Promise<unknown>;
  onRemove?: () => void;
  plain?: boolean;
  // Under a remote scope where this client can forward, the forward's
  // band (ForwardControl), framed by forwardBandClass.
  forward?: ReactNode;
}) {
  const { port, label, source, listening } = entry;
  const [editing, setEditing] = useState(false);
  // Forwarding lands the remote port on this machine, so under a remote
  // scope Open means the local end and lives in the forward band. A
  // client that cannot forward (the browser) has no local end to open.
  // Locally the port is right here.
  const where = remote ? "on that device" : "here";

  return (
    <li
      className={cn(
        "overflow-hidden",
        plain ? "-mx-3" : "rounded-lg border border-border bg-card",
      )}
    >
      {editing && onUpdate !== undefined ? (
        <PortFormView
          initial={{ port, label }}
          taken={taken}
          onSubmit={onUpdate}
          onDone={() => setEditing(false)}
          className="px-3 py-2"
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <SimpleTooltip
            tip={
              listening
                ? `A server is listening ${where}`
                : `Nothing is listening ${where} right now`
            }
          >
            <StatusDot
              tone={listening ? "emerald" : "slate"}
              pulse={listening}
              className={cn(!listening && "opacity-40")}
            />
          </SimpleTooltip>
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "truncate text-sm font-medium",
                label === undefined && "font-mono tabular",
              )}
            >
              {label ?? port}
            </span>
            {label !== undefined && (
              <span className="tabular font-mono text-xs text-muted-foreground">
                {port}
              </span>
            )}
            <RowTag>{SOURCE_LABEL[source]}</RowTag>
          </div>

          <div className="ml-auto flex items-center gap-0.5">
            {!remote && <OpenLocalhostButtonView port={port} />}
            {onUpdate !== undefined && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Edit port ${port}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(true)}
              >
                <Pencil />
              </Button>
            )}
            {onRemove !== undefined && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove port ${port}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={onRemove}
              >
                <X />
              </Button>
            )}
          </div>
        </div>
      )}

      {forward}
    </li>
  );
}

// The forward band's frame and inset under a row: set in under the
// label on a plain row, a band of its own on a card.
export function forwardBandClass(plain: boolean): string {
  return plain
    ? // The header's px-3, the dot and its gap-x-3: under the label.
      "pr-3 pb-1.5 pl-7.5"
    : "border-t border-border bg-muted/40 px-3 py-1.5";
}
