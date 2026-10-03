// The forward mark (ForwardMarkView), with the forward looked up.
import type { Worktree } from "@shared/schemas";
import { useWorktreeForwardTip } from "@/hooks/remote/usePortForwards";
import { ForwardMarkView } from "./ForwardMarkView";

export function ForwardMark({
  deviceId,
  worktree,
}: {
  deviceId: string;
  worktree: Worktree;
}) {
  return <ForwardMarkView tip={useWorktreeForwardTip(deviceId, worktree)} />;
}
