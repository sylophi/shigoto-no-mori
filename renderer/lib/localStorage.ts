// The one place renderer-persisted UI preferences touch localStorage.
// Access is guarded because localStorage can throw outright, and a
// preference is never worth taking a render down for. Keeping the
// try/catch here also keeps it out of component bodies, where React
// Compiler bails out over a conditional inside one.

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Unavailable storage costs the next launch its boot hint, nothing more.
  }
}
