// Paths in a worktree's file tree, relative to its root.

export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

// Every folder above a path, outermost first: what has to be open for
// the path's own row to be on screen.
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
