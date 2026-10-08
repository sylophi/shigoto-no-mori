import { useEffect } from "react";
import { createExternalStore } from "@/store/externalStore";
import type { SidebarRow } from "../sidebarRow";

type InboxWorktreeRow = Extract<SidebarRow, { kind: "inbox-worktree" }>;

// The inbox's rows in the order on screen, while the sidebar shows the
// inbox, else null. For leaving a worktree's page (a delete, a worktree
// gone from under it) to land on the list the user is looking at,
// rather than on the root or a neighbour in the project's own order
// (whose first entry is the primary, a page the inbox has no row for
// and leaves the inbox to show).
//
// Read at the moment of the move, never subscribed to: the rows are
// rebuilt on every sidebar render, and nothing draws off them.
const store = createExternalStore<readonly SidebarRow[] | null>(null);

export function useShareInboxOrder(
  rows: readonly SidebarRow[],
  showing: boolean,
): void {
  useEffect(() => {
    if (!showing) return;
    store.publish(rows);
    return () => store.publish(null);
  });
}

export function inboxShowing(): boolean {
  return store.get() !== null;
}

// The inbox's top worktree row (its newest work, or a group's) on a
// device that can be reached, or undefined when there is none or the
// inbox isn't showing. `gone` names worktrees on `device` (undefined
// for this machine), since a worktree id is only unique per device: a
// repo at the same path on two machines has the same id on both.
export function inboxTopRow(
  device: string | undefined,
  gone: readonly string[],
): InboxWorktreeRow | undefined {
  return store
    .get()
    ?.find(
      (row): row is InboxWorktreeRow =>
        row.kind === "inbox-worktree" &&
        row.device?.reachable !== false &&
        !(row.device?.deviceId === device && gone.includes(row.worktree.id)),
    );
}
