// The worktree's ports: what port-pool allocated it, plus whatever the
// user added, each with a live dot for "something is listening there
// right now". Locally each row opens in the browser. Under a remote
// scope each row is also a forward switch: bring that port to this
// machine's localhost over the device connection, at a local port of
// the user's choosing (app-only, since a browser cannot bind a
// listener, and the web client sees the rows read-only).
//
// The section exists whenever there is something to show OR something
// the viewer may add, so a repo without port-pool still gets a place to
// pin its dev server's port. External worktrees have no data file, so
// they only show port-pool rows, and only when there are some.
import { useState } from "react";
import { Plus } from "lucide-react";
import {
  hasWorktreeData,
  MAX_CUSTOM_PORTS,
  type Worktree,
} from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { useCustomPortsWrite } from "@/hooks/ports/useCustomPorts";
import { useWorktreePorts } from "@/hooks/ports/useWorktreePorts";
import { useWorktreeData } from "@/hooks/worktrees/useWorktreeData";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { PortForm } from "./PortForm";
import { PortRow } from "./PortRow";

export function PortsSection({ worktree }: { worktree: Worktree }) {
  const { deviceId, remote } = useHostScope();
  const { granted } = useCommandAccess();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const canEdit = granted && hasWorktreeData(worktree);
  const portsQuery = useWorktreePorts(worktree, { canEdit });
  const customPorts = useCustomPortsWrite(worktree);
  const [adding, setAdding] = useState(false);
  const ports = portsQuery.data?.ports ?? [];
  // The cap is on the stored list, which the merged one under-counts:
  // a custom entry on a number port-pool later allocated is shadowed
  // by the pool row and shows nowhere, but still occupies a slot.
  const { data: stored } = useWorktreeData(worktree.projectId, worktree.id);
  const atCap = (stored?.ports?.length ?? 0) >= MAX_CUSTOM_PORTS;

  if (ports.length === 0 && !canEdit) {
    // Nothing to show and nothing to offer, whether the read is still
    // in flight or came back empty: stay out of the page.
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Ports</SectionHeading>
        {canEdit && !adding && (
          <SimpleTooltip
            tip={
              atCap
                ? `Up to ${MAX_CUSTOM_PORTS} custom ports per worktree`
                : undefined
            }
          >
            {/* The span is the trigger: a disabled button dispatches no
                pointer events, and disabled is when the tip matters. */}
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground"
                disabled={atCap}
                onClick={() => setAdding(true)}
              >
                <Plus />
                Add port
              </Button>
            </span>
          </SimpleTooltip>
        )}
      </div>

      {portsQuery.isPending ? (
        <Skeleton className="h-10 w-full rounded-lg" />
      ) : ports.length === 0 && !adding ? (
        <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
          {portsQuery.isError
            ? `Couldn't read this worktree's ports from ${deviceLabel}.`
            : "Nothing listed yet. Ports port-pool allocates show up here on their own; add any other port this worktree serves."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {ports.map((entry) => (
            <PortRow
              key={entry.port}
              entry={entry}
              taken={ports}
              deviceId={deviceId}
              remote={remote}
              granted={granted}
              onUpdate={
                entry.source === "custom" && canEdit
                  ? (next) => customPorts.update(entry.port, next)
                  : undefined
              }
              onRemove={
                entry.source === "custom" && canEdit
                  ? () => customPorts.remove(entry.port)
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {adding && (
        <PortForm
          taken={ports}
          onSubmit={(entry) => customPorts.add(entry)}
          onDone={() => setAdding(false)}
          className="rounded-lg border border-dashed border-border bg-card px-3 py-2"
        />
      )}
    </section>
  );
}
