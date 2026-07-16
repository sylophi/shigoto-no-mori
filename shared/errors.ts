// "Entity gone" errors: a project/worktree was deleted out from under a
// call (worktree delete, project removal, nuke racing a renderer poll).
// Electron's IPC serialization only preserves the message string, so the
// renderer can recognize these solely by message text. Keeping the
// constructors and the matcher in one module means main can't reword a
// message without the matcher following along.
const ENTITY_GONE_PREFIXES = ["Unknown project:", "Unknown worktree:"];

export function unknownProjectError(projectId: string): Error {
  return new Error(`Unknown project: ${projectId}`);
}

export function unknownWorktreeError(worktreeId: string): Error {
  return new Error(`Unknown worktree: ${worktreeId}`);
}

// Matches both the raw main-process error and the renderer-side form
// Electron wraps as "Error invoking remote method '…': Error: <msg>".
export function isEntityGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ENTITY_GONE_PREFIXES.some((prefix) => message.includes(prefix));
}
