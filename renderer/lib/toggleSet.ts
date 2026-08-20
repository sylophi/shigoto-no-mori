// Set-state updater for a value that's either in or out -- every
// multi-select surface in the app is exactly this.
export function withToggled<T>(value: T) {
  return (prev: Set<T>): Set<T> => {
    const next = new Set(prev);
    if (!next.delete(value)) next.add(value);
    return next;
  };
}
