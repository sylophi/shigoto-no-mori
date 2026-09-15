// Why a pull of a branch onto this device is refused up front, told
// once: the pull handler (host/ipc/modules/sync.ts) throws it, and the
// transplant review shows it before the user gets that far, so the
// two never drift apart.
// Why a pull under the source's folder name is refused up front: the
// name is taken here (a worktree of this project by that name, case-
// insensitively, or anything at the path), the same rule the CLI
// create applies (cli/worktree.go).
export function pullFolderCollision(name: string, path: string): string {
  return `A folder named ${name} already exists here (${path}). Remove or rename it first.`;
}

export function pullBranchCollision(
  branch: string,
  holderPath: string | undefined,
): string {
  return holderPath === undefined
    ? `${branch} already exists on this device. Delete that branch first, or open it and pull normally.`
    : `${branch} is already checked out at ${holderPath} on this device. Stop or delete that worktree first.`;
}
