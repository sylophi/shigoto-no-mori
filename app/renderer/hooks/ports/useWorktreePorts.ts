// The worktree's port list off the scoped host (packages/contracts/src/modules/
// ports.ts): port-pool's allocation plus the user-added entries, each
// with a loopback liveness probe. It is the host's view (ports:watch),
// which probes again every few seconds while anyone reads it, so a dev
// server starting or stopping on the host shows up on its own, and an
// added port with the next write of the worktree's data. The readers are
// the worktree page's Ports section, the Ports dialog and the Live page's
// cards of worktrees running a script.
import { callOf } from "@shigomori/contracts/contract";
import { portsContract } from "@shigomori/contracts/modules/ports";
import type { WorktreePortsResult } from "@shigomori/contracts/schemas";
import * as Atom from "effect/reactivity/Atom";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { type LiveViewState, useView } from "@/lib/runtime/viewHooks";

const worktreePortsAtom = Atom.family((key: string) => {
  const [deviceId = "", projectId = "", worktreeId = ""] = key.split("\n");
  return hostViewAtom({
    deviceId,
    localDeviceId,
    view: callOf(portsContract, "watch"),
    input: { projectId, worktreeId },
  });
});

export function useWorktreePorts(worktree: {
  projectId: string;
  id: string;
}): LiveViewState<WorktreePortsResult> {
  const { deviceId, hasHost } = useHostScope();
  return useView(
    hasHost
      ? worktreePortsAtom(`${deviceId}\n${worktree.projectId}\n${worktree.id}`)
      : null,
  );
}
