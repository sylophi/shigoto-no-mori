// Pure array reordering used by both the main process (when persisting
// the new order to disk) and the renderer (for the optimistic React
// Query cache write before the IPC round-trip resolves).
export function reorderProjects<T extends { id: string }>(
  items: T[],
  draggedId: string,
  targetId: string,
  position: "before" | "after",
): T[] {
  if (draggedId === targetId) return items;

  const draggedIndex = items.findIndex((p) => p.id === draggedId);
  if (draggedIndex < 0) return items;

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  if (!dragged) return items;

  const targetIndex = next.findIndex((p) => p.id === targetId);
  if (targetIndex < 0) return items;

  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, dragged);
  return next;
}
