// A hook for an implementation the composition root wires in at boot
// (main/electron/hostImpls.ts, main/ipc/handlers.ts, a test's setup).
// Handler modules stay free of Electron and of the wiring; each keeps
// one slot and throws its own message when something calls through
// before the setter ran.
export function implSlot<T>(unwired: string): {
  set: (next: T) => void;
  get: () => T;
  orNull: () => T | null;
} {
  let impl: T | null = null;
  return {
    set: (next) => {
      impl = next;
    },
    get: () => {
      if (impl === null) throw new Error(unwired);
      return impl;
    },
    orNull: () => impl,
  };
}
