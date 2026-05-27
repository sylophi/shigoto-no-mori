// Fixture: a dynamic import of the electron module. Dynamic imports
// are always runtime, so this should fire `lib-electron-runtime`.
export async function loadElectron(): Promise<unknown> {
  return await import("electron");
}
