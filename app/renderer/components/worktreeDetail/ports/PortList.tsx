// A worktree's ports, shared by the worktree page's Ports section and
// the Ports dialog the Live page opens. The rows are what port-pool
// allocated plus whatever the user added, each with a live dot for
// "something is listening there right now". Locally each row opens in
// the browser. Under a remote scope each row is also a forward switch:
// bring that port to this machine's localhost over the device
// connection, at a local port of the user's choosing (app-only, since a
// browser cannot bind a listener, and the web client sees the rows
// read-only).
//
// Adding is for a worktree with a data file and a viewer with command
// access. External worktrees have no data file, so they only show
// port-pool rows. The list and its actions (PortActions) are separate
// so each frame places the actions its own way, and share one read and
// one add form (usePortList).
import { useState } from "react";
import { Plus } from "lucide-react";
import {
  hasWorktreeData,
  MAX_CUSTOM_PORTS,
  type Worktree,
} from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useCustomPortsWrite } from "@/hooks/ports/useCustomPorts";
import { useWorktreePorts } from "@/hooks/ports/useWorktreePorts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useWorktreeData } from "@/hooks/worktrees/useWorktreeData";
import { ForwardAllButton } from "./ForwardAllButton";
import { PortForm } from "./PortForm";
import { PortRow } from "./PortRow";

export type PortListState = ReturnType<typeof usePortList>;

export function usePortList(worktree: Worktree) {
  const { deviceId, remote } = useHostScope();
  // canCommand: granted, or the verdict still in flight, so the list
  // does not show read-only and turn editable a moment later (the
  // page's own rule).
  const { canCommand: granted } = useCommandAccess();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const canEdit = granted && hasWorktreeData(worktree);
  const portsQuery = useWorktreePorts(worktree);
  const customPorts = useCustomPortsWrite(worktree);
  const [adding, setAdding] = useState(false);
  // The cap is on the stored list, which the merged one under-counts:
  // a custom entry on a number port-pool later allocated is shadowed
  // by the pool row and shows nowhere, but still occupies a slot.
  const storedQuery = useWorktreeData(
    canEdit ? worktree.projectId : null,
    canEdit ? worktree.id : null,
  );
  const atCap = (storedQuery.data?.ports?.length ?? 0) >= MAX_CUSTOM_PORTS;
  return {
    deviceId,
    remote,
    granted,
    deviceLabel,
    canEdit,
    isPending: portsQuery.isPending,
    isError: portsQuery.isError,
    ports: portsQuery.data?.ports ?? [],
    customPorts,
    forwardFrom: { projectId: worktree.projectId, worktreeId: worktree.id },
    adding,
    setAdding,
    atCap,
    // The form checks duplicates against the list and the cap against
    // the stored one, so it waits for both reads.
    canAdd:
      canEdit && !atCap && !portsQuery.isPending && !storedQuery.isPending,
  };
}

// `plain`: rows without the cards' borders and fills (PortRow).
export function PortList({
  state,
  plain = false,
}: {
  state: PortListState;
  plain?: boolean;
}) {
  const {
    deviceId,
    remote,
    granted,
    deviceLabel,
    canEdit,
    isPending,
    isError,
    ports,
    customPorts,
    forwardFrom,
    adding,
    setAdding,
  } = state;
  return (
    <div className="space-y-3">
      {isPending ? (
        <Skeleton className="h-10 w-full rounded-lg" />
      ) : ports.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {ports.map((entry) => (
            <PortRow
              key={entry.port}
              entry={entry}
              taken={ports}
              deviceId={deviceId}
              worktree={forwardFrom}
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
              plain={plain}
            />
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="text-sm text-muted-foreground">
            {isError
              ? `Couldn't read this worktree's ports${remote ? ` from ${deviceLabel}` : ""}.`
              : "No ports yet."}
          </p>
        )
      )}
      {adding && (
        <PortForm
          taken={ports}
          onSubmit={(entry) => customPorts.add(entry)}
          onDone={() => setAdding(false)}
          className="rounded-lg border border-dashed border-border bg-card px-3 py-2"
        />
      )}
    </div>
  );
}

// Forward all (on a peer) and Add port, whichever apply.
export function PortActions({ state }: { state: PortListState }) {
  const {
    deviceId,
    remote,
    granted,
    canEdit,
    ports,
    forwardFrom,
    adding,
    setAdding,
    atCap,
    canAdd,
  } = state;
  return (
    <>
      {remote && canForwardPorts && (
        <ForwardAllButton
          deviceId={deviceId}
          worktree={forwardFrom}
          ports={ports}
          granted={granted}
        />
      )}
      {canEdit && !adding && (
        <SimpleTooltip
          tip={
            atCap
              ? `Up to ${MAX_CUSTOM_PORTS} custom ports per worktree`
              : undefined
          }
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={!canAdd}
            onClick={() => setAdding(true)}
          >
            <Plus />
            Add port
          </Button>
        </SimpleTooltip>
      )}
    </>
  );
}
