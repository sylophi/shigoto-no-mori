// "Entity gone" errors: a project/worktree was deleted out from under a
// call (worktree delete, project removal, nuke racing a renderer poll).
// Electron's IPC serialization only preserves the message string, so the
// renderer can recognize these solely by message text. Keeping the
// constructors and the matcher in one module means main can't reword a
// message without the matcher following along.
const ENTITY_GONE_PREFIXES = ["Unknown project:", "Unknown worktree:"];

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unknownProjectError(projectId: string): Error {
  return new Error(`Unknown project: ${projectId}`);
}

export function unknownWorktreeError(worktreeId: string): Error {
  return new Error(`Unknown worktree: ${worktreeId}`);
}

// Message-text match, so it works on every wire alike: the preload
// transport strips Electron's "Error invoking remote method" wrapper
// before a rejection reaches the renderer, and the socket transports
// deliver the handler's message as-is.
export function isEntityGoneError(error: unknown): boolean {
  const message = errorMessageOf(error);
  return ENTITY_GONE_PREFIXES.some((prefix) => message.includes(prefix));
}

// Safe branch delete (`git branch -d`) refused because the branch has
// commits unreachable from other refs. Same message-text contract as
// above: the renderer matches on the marker to swap its confirm dialog
// into a force-delete prompt with friendlier copy than git's stderr.
// The marker is deliberately NOT the phrase git prints ("is not fully
// merged") so the two layers stay distinct: host/lib/git/branches.ts
// detects git's stderr and rethrows this error.
const BRANCH_NOT_MERGED_MARKER = "has unmerged commits";

export function branchNotMergedError(name: string): Error {
  return new Error(`Branch '${name}' ${BRANCH_NOT_MERGED_MARKER}.`);
}

export function isBranchNotMergedError(error: unknown): boolean {
  return errorMessageOf(error).includes(BRANCH_NOT_MERGED_MARKER);
}
