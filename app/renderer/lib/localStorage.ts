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

// A JSON value, or `fallback` when the key is missing, unparseable, or
// not an object. Callers still validate the shape. This only takes the
// try/catch out of their bodies.
export function readStoredJson<T extends object>(key: string, fallback: T): T {
  const raw = readStored(key);
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // See writeStored.
  }
}
