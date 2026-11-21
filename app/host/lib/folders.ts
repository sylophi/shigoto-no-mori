// The folders a browse lists, for the fs handlers.
import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { byFamily } from "@shigomori/engine/platform";
import { home, toAbsolute } from "@shared/paths";

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

async function presentDrives() {
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
  return roots.filter((_, i) => present[i]);
}

async function listDrives() {
  const drives = await presentDrives();
  return {
    path: "/",
    entries: drives.map((name) => ({ name, isGitRepo: false })),
  };
}

// The folders in `path`, its failure as it crosses a wire. Windows has a
// root per drive, so a browse up from one lists them all under "/".
export const listFolder = (path: string) =>
  Effect.tryPromise({
    try: () =>
      byFamily({
        posix: listDirectory,
        windows: (at: string) =>
          at === "/" ? listDrives() : listDirectory(at),
      })(path),
    catch: callFailureOf,
  });

// A line of `mount`'s: `<what> on <where> [type <fs> ](<options>)`, the
// type in Linux's alone.
const MOUNT_LINE = / on (.+?) (?:type \S+ )?\(([^()]*)\)$/;
// Where a Mac and a Linux desktop mount the volumes a person plugs in.
const VOLUME_ROOTS = ["/Volumes/", "/media/", "/run/media/"];

// The mounts a file manager lists, less the ones the system hides from
// it (a Mac's Recovery is `nobrowse`).
const mountedVolumes = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(ChildProcess.make("mount"));
  return output.split("\n").flatMap((line) => {
    const [, path = "", options = ""] = MOUNT_LINE.exec(line) ?? [];
    const shown =
      VOLUME_ROOTS.some((root) => path.startsWith(root)) &&
      !options.split(/,\s*/).includes("nobrowse");
    return shown ? [{ name: basename(path), path }] : [];
  });
});

// The volumes a browse offers to jump to, its failure as it crosses a
// wire. Windows's are its drives but the home's, as a Mac's boot volume
// isn't among its mounts under /Volumes.
export const listVolumes = byFamily({
  posix: mountedVolumes,
  windows: Effect.promise(presentDrives).pipe(
    Effect.map((drives) =>
      drives
        .filter((name) => !home().startsWith(name))
        .map((name) => ({ name, path: `${name}/` })),
    ),
  ),
}).pipe(Effect.mapError(callFailureOf));
