// Why a pull of a branch onto this device is refused up front, told
// once: the pull's landing (host/lib/sync/landing.ts) throws it, and the
// transplant review shows it before the user gets that far, so the
// two never drift apart.
// Why a pull under the source's folder name is refused up front: the
// name is taken here (a worktree of this project by that name, case-
// insensitively, or anything at the path), the same rule the
// engine's create applies (Worktrees.ts).
// `where` places the landing device when it is not the one speaking
// ("on MacBook"): the review of a flow to a peer, told from the
// sending side.
export function pullFolderCollision(
  name: string,
  path: string,
  where = "here",
): string {
  return `A folder named ${name} already exists ${where} (${path}). Remove or rename it first.`;
}

// The worktree holding the branch goes by its name, as the sidebar
// shows it, and a shelved one says so, since it's out of the list.
export function pullBranchCollision(
  branch: string,
  holder: { readonly name: string; readonly shelved: boolean } | undefined,
  where = "on this device",
): string {
  if (holder === undefined) {
    return `${branch} already exists ${where}. Delete that branch first, or open it and pull normally.`;
  }
  return holder.shelved
    ? `${branch} is already checked out ${where} in ${holder.name}, which is shelved. Delete that worktree first, or unshelve it and pull normally.`
    : `${branch} is already checked out ${where} in ${holder.name}. Delete that worktree first, or open it and pull normally.`;
}

// The branch whose place in git's ref tree a new one would take: refs
// are a directory tree, so mirror/main is refused by a branch named
// mirror, and a branch named mirror by mirror/main.
export function branchInTheWay(
  branch: string,
  local: readonly string[],
): string | undefined {
  return local.find(
    (name) => name.startsWith(`${branch}/`) || branch.startsWith(`${name}/`),
  );
}

export function pullBranchInTheWay(
  branch: string,
  inTheWay: string,
  where = "here",
): string {
  return `${branch} cannot be created ${where}: a branch named ${inTheWay} is in the way (git allows one of the two). Rename that branch first.`;
}
