import type { PortForwardSummary } from "@shared/ipc/modules/portForward";

// What the marks on a peer's worktree (the sidebar row, the Ports
// button) say while this machine forwards its ports, matched on the
// worktree each forward was switched on from (the note on the
// contract's worktree field). Undefined while nothing is forwarded.
export function worktreeForwardTip(
  forwards: readonly PortForwardSummary[],
  deviceId: string,
  worktree: { projectId: string; id: string },
): string | undefined {
  const pairs = forwards
    .filter(
      (forward) =>
        forward.deviceId === deviceId &&
        forward.worktree?.projectId === worktree.projectId &&
        forward.worktree.worktreeId === worktree.id,
    )
    .map(
      (forward) => `${forward.remotePort} to localhost:${forward.localPort}`,
    );
  return pairs.length > 0 ? `Forwarding ${pairs.join(", ")}` : undefined;
}
