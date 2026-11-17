// The folders a browse lists, for the fs handlers.
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { byPlatform } from "@shigomori/engine/platform";
import { toAbsolute } from "@shared/paths";

async function listDirectory(path: string) {
  const absolute = toAbsolute(path);

  const entries = await readdir(absolute, { withFileTypes: true });
  const dirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith("."),
  );
  // Async check in parallel beats `existsSync` per entry: same logic,
  // doesn't block the event loop on slow filesystems.
  const checked = await Promise.all(
    dirs.map(async (e) => {
      try {
        await access(join(absolute, e.name, ".git"));
        return { name: e.name, isGitRepo: true };
      } catch {
        return { name: e.name, isGitRepo: false };
      }
    }),
  );
  const result = checked.toSorted((a, b) => a.name.localeCompare(b.name));

  return { path: absolute, entries: result };
}

async function listDrives() {
  const roots = Array.from(
    { length: 26 },
    (_, i) => `${String.fromCharCode(65 + i)}:`,
  );
  const present = await Promise.all(
    roots.map((root) =>
      access(`${root}/`).then(
        () => true,
        () => false,
      ),
    ),
  );
  return {
    path: "/",
    entries: roots
      .filter((_, i) => present[i])
      .map((name) => ({ name, isGitRepo: false })),
  };
}

// The folders in `path`, its failure as it crosses a wire. Windows has a
// root per drive, so a browse up from one lists them all under "/".
export const listFolder = (path: string) =>
  Effect.tryPromise({
    try: () =>
      byPlatform({
        darwin: listDirectory,
        linux: listDirectory,
        win32: (at: string) => (at === "/" ? listDrives() : listDirectory(at)),
      })(path),
    catch: callFailureOf,
  });
