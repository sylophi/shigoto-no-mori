import { join } from "node:path";

// A `~/` path joined to `home` and cleaned as Go's filepath.Join cleans
// it, and any other path as it is. The engine's Paths and the app's host
// (app/shared/paths.ts) each read the home directory themselves.
export const expandHome = (home: string, target: string) => {
  if (target === "~") return home;
  if (!target.startsWith("~/")) return target;
  const joined = join(home, target.slice(2));
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
};
