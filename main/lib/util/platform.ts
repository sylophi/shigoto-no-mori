// Single platform fact for the main process, mirroring the renderer's
// lib/platform.ts. Import this instead of re-deriving from
// process.platform so platform branches stay greppable in one shape.
export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
