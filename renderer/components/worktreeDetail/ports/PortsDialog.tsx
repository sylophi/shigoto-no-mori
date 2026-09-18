// The worktree's ports, behind the footer's Ports button (PortsButton)
// on both the local and the remote worktree page, in the frame the
// mirror and transplant dialogs use so the footer's verbs look like
// one family. The rows are what port-pool allocated plus whatever the
// user added, each with a live dot for "something is listening there
// right now". Locally each row opens in the browser. Under a remote
// scope each row is also a forward switch: bring that port to this
// machine's localhost over the device connection, at a local port of
// the user's choosing (app-only, since a browser cannot bind a
// listener, and the web client sees the rows read-only).
//
// Adding is for a worktree with a data file and a viewer with command
// access. External worktrees have no data file, so they only show
// port-pool rows.
import { useState } from "react";
import { Cable, Plus } from "lucide-react";
import {
  hasWorktreeData,
  MAX_CUSTOM_PORTS,
  type Worktree,
} from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { TONE_PILL } from "@/components/ui/status-dot";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useCustomPortsWrite } from "@/hooks/ports/useCustomPorts";
import { useWorktreePorts } from "@/hooks/ports/useWorktreePorts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useWorktreeData } from "@/hooks/worktrees/useWorktreeData";
import {
  FlowHeader,
  TransplantBody,
  TransplantFooter,
} from "../transplant/TransplantChrome";
import { ForwardAllButton } from "./ForwardAllButton";
import { PortForm } from "./PortForm";
import { PortRow } from "./PortRow";

export function PortsDialog({
  worktree,
  onClose,
}: {
  worktree: Worktree;
  onClose: () => void;
}) {
  const { deviceId, remote } = useHostScope();
  // canCommand: granted, or the verdict still in flight, so the dialog
  // does not open read-only and turn editable a moment later (the
  // page's own rule).
  const { canCommand: granted } = useCommandAccess();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const canEdit = granted && hasWorktreeData(worktree);
  const portsQuery = useWorktreePorts(worktree);
  const customPorts = useCustomPortsWrite(worktree);
  const [adding, setAdding] = useState(false);
  const ports = portsQuery.data?.ports ?? [];
  // The cap is on the stored list, which the merged one under-counts:
  // a custom entry on a number port-pool later allocated is shadowed
  // by the pool row and shows nowhere, but still occupies a slot.
  const storedQuery = useWorktreeData(
    canEdit ? worktree.projectId : null,
    canEdit ? worktree.id : null,
  );
  const atCap = (storedQuery.data?.ports?.length ?? 0) >= MAX_CUSTOM_PORTS;
  // The form checks duplicates against the list and the cap against
  // the stored one, so it waits for both reads.
  const canAdd = canEdit && !portsQuery.isPending && !storedQuery.isPending;

  return (
    <ModalShell
      onClose={onClose}
      popoverClassName="flex max-h-[85vh] max-w-2xl flex-col"
    >
      <FlowHeader
        tint={TONE_PILL.sky}
        icon={Cable}
        title={remote ? `Ports on ${deviceLabel}` : "Ports"}
        onClose={onClose}
      >
        <p>
          {remote
            ? canForwardPorts
              ? "Switch a port on to reach it at localhost here, at a local port of your choosing. A forward stays on while its server is down."
              : `What ${deviceLabel} serves from this worktree. Forwarding needs the app.`
            : "What this worktree serves."}
        </p>
      </FlowHeader>
      <TransplantBody>
        <div className="space-y-3">
          {portsQuery.isPending ? (
            <Skeleton className="h-10 w-full rounded-lg" />
          ) : ports.length > 0 ? (
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
          ) : (
            !adding && (
              <p className="text-sm text-muted-foreground">
                {portsQuery.isError
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
      </TransplantBody>
      <TransplantFooter>
        {remote && canForwardPorts && (
          <ForwardAllButton
            deviceId={deviceId}
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
            {/* The span is the trigger: a disabled button dispatches no
                pointer events, and disabled is when the tip matters. */}
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                disabled={atCap || !canAdd}
                onClick={() => setAdding(true)}
              >
                <Plus />
                Add port
              </Button>
            </span>
          </SimpleTooltip>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </TransplantFooter>
    </ModalShell>
  );
}
