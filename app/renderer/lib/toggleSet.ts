// Set-state updater for a value that's either in or out. Every
// multi-select surface in the app is exactly this.
export function withToggled<T>(value: T) {
  return (prev: Set<T>): Set<T> => {
    const next = new Set(prev);
    if (!next.delete(value)) next.add(value);
    return next;
  };
}

// Set-state updater that puts `value` in or out of a set, as asked
// rather than flipped. Hands back the same set when nothing moves, so
// a no-op doesn't re-render what reads it.
export function withMember<T>(
  prev: ReadonlySet<T>,
  value: T,
  present: boolean,
): ReadonlySet<T> {
  if (prev.has(value) === present) return prev;
  const next = new Set(prev);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}
