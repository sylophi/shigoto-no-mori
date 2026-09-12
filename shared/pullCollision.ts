// Why a pull of a branch onto this device is refused up front, told
// once: the pull handler (host/ipc/modules/sync.ts) throws it, and the
// transplant review shows it before the user gets that far, so the
// two never drift apart.
export function pullBranchCollision(
  branch: string,
  holderPath: string | undefined,
): string {
  return holderPath === undefined
    ? `${branch} already exists on this device. Delete that branch first, or open it and pull normally.`
    : `${branch} is already checked out at ${holderPath} on this device. Stop or delete that worktree first.`;
}
