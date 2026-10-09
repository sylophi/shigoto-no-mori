// A worktree's ports as a list, and its actions (PortList binds them).
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import {
  MAX_CUSTOM_PORTS,
  type CustomPort,
  type WorktreePort,
} from "@shigomori/contracts/schemas";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PortFormView } from "./PortFormView";

// `plain`: rows without the cards' borders and fills (PortRowView), and
// an add form without its fill, set out as far as the rows.
export function PortListView({
  pending,
  failed,
  rows,
  adding,
  taken,
  onAdd,
  onAddDone,
  plain = false,
}: {
  pending: boolean;
  // Why there are no rows: the read failed, in a sentence.
  failed: string | undefined;
  // The rows (PortRow).
  rows: ReactNode[];
  adding: boolean;
  // Every listed port, for the add form's duplicate check.
  taken: readonly WorktreePort[];
  onAdd: (entry: CustomPort) => Promise<unknown>;
  onAddDone: () => void;
  plain?: boolean;
}) {
  return (
    <div className="space-y-3">
      {pending ? (
        <Skeleton className="h-10 w-full rounded-lg" />
      ) : rows.length > 0 ? (
        <ul className="flex flex-col gap-1.5">{rows}</ul>
      ) : (
        !adding && (
          <p className="text-sm text-muted-foreground">
            {failed ?? "No ports yet."}
          </p>
        )
      )}
      {adding && (
        <PortFormView
          taken={taken}
          onSubmit={onAdd}
          onDone={onAddDone}
          className={cn(
            "rounded-lg border border-dashed border-border px-3 py-2",
            plain ? "-mx-3" : "bg-card",
          )}
        />
      )}
    </div>
  );
}

// Forward all (on a peer) and Add port, whichever apply.
export function PortActionsView({
  forwardAll,
  canEdit,
  adding,
  atCap,
  canAdd,
  onAdd,
}: {
  // The bulk forwards (ForwardAllButton), on a peer where this client
  // can forward.
  forwardAll?: ReactNode;
  canEdit: boolean;
  adding: boolean;
  // The worktree holds as many custom ports as it may.
  atCap: boolean;
  canAdd: boolean;
  onAdd: () => void;
}) {
  return (
    <>
      {forwardAll}
      {canEdit && !adding && (
        <SimpleTooltip
          tip={
            atCap
              ? `Up to ${MAX_CUSTOM_PORTS} custom ports per worktree`
              : undefined
          }
        >
          <Button variant="ghost" size="sm" disabled={!canAdd} onClick={onAdd}>
            <Plus />
            Add port
          </Button>
        </SimpleTooltip>
      )}
    </>
  );
}
