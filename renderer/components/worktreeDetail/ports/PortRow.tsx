// One port of a worktree, as a small card in two parts. The header
// names it (live dot, label, number, where it came from) and holds the
// row's own actions on the right: Open, and for a custom port, Edit
// and Remove. Under a remote scope a second band carries the forward:
// the `from -> localhost:port` form on the left and the switch on the
// right (ForwardControl). Locally there is nothing to forward, so the
// header is the whole card.
import { useState } from "react";
import { Pencil, X } from "lucide-react";
import type { CustomPort, WorktreePort } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { RowTag } from "@/components/ui/row-tag";
import { StatusDot } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { cn } from "@/lib/utils";
import { ForwardControl } from "./ForwardControl";
import { OpenLocalhostButton } from "./OpenLocalhostButton";
import { PortForm } from "./PortForm";

const SOURCE_LABEL: Record<WorktreePort["source"], string> = {
  pool: "port-pool",
  custom: "custom",
};

export function PortRow({
  entry,
  taken,
  deviceId,
  remote,
  granted,
  onUpdate,
  onRemove,
}: {
  entry: WorktreePort;
  // Every listed port, for the edit form's duplicate check.
  taken: readonly WorktreePort[];
  deviceId: string;
  remote: boolean;
  granted: boolean;
  // Present only when this row may be changed (a custom entry, and the
  // viewer holds command access on the host).
  onUpdate?: (next: CustomPort) => Promise<unknown>;
  onRemove?: () => void;
}) {
  const { port, label, source, listening } = entry;
  const [editing, setEditing] = useState(false);
  // Forwarding lands the remote port on this machine, so under a remote
  // scope Open means the local end and lives in the forward band. A
  // client that cannot forward (the browser) has no local end to open.
  // Locally the port is right here.
  const control = remote && canForwardPorts;
  const where = remote ? "on that device" : "here";

  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card">
      {editing && onUpdate !== undefined ? (
        <PortForm
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
            {/* The span takes the tooltip's trigger props; StatusDot
                spreads none. */}
            <span className={cn("inline-flex", !listening && "opacity-40")}>
              <StatusDot
                tone={listening ? "emerald" : "slate"}
                pulse={listening}
              />
            </span>
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
            {!remote && <OpenLocalhostButton port={port} />}
            {onUpdate !== undefined && (
              <SimpleTooltip tip="Edit this port">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit port ${port}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setEditing(true)}
                >
                  <Pencil />
                </Button>
              </SimpleTooltip>
            )}
            {onRemove !== undefined && (
              <SimpleTooltip tip="Remove this port">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove port ${port}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={onRemove}
                >
                  <X />
                </Button>
              </SimpleTooltip>
            )}
          </div>
        </div>
      )}

      {control && (
        <ForwardControl
          deviceId={deviceId}
          remotePort={port}
          granted={granted}
        />
      )}
    </li>
  );
}
