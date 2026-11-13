import { byPlatform } from "./platform.ts";

// A path as the engine keeps, compares, hashes, stores and sends it: one
// spelling per folder, made where a path comes in (git's output, typed
// input, the OS). On macOS and Linux it is the OS's own spelling.
export const canonicalPath = (raw: string): string =>
  byPlatform({ darwin: raw, linux: raw });
