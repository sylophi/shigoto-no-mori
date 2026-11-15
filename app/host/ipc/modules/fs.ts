import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fsContract } from "@shigomori/contracts/modules/fs";
import { callFailureOf } from "@shigomori/contracts/errors";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Git from "@shigomori/engine/Git";
import * as Projects from "@shigomori/engine/Projects";
import { byPlatform } from "@shigomori/engine/platform";
import type * as Engine from "@host/lib/Engine";
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

// Windows has a root per drive, so a browse up from one lists them
// all under "/".
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

// Node's file system, its failure as it crosses a wire.
const onDisk = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

export const fsHandlers = {
  listDirectory: ({ path }) =>
    onDisk(() =>
      byPlatform({
        darwin: listDirectory,
        linux: listDirectory,
        win32: (at: string) => (at === "/" ? listDrives() : listDirectory(at)),
      })(path),
    ),

  // `git rev-parse --git-dir` validates a real working repo: catches
  // missing/corrupted .git, bare repos, and linked worktrees alike.
  isGitRepo: ({ path }) =>
    Effect.flatMap(Git.Git, (git) => git.isRepo(toAbsolute(path))),

  scanForGitRepos: ({ path }) =>
    Effect.flatMap(Projects.Projects, (projects) =>
      projects.scan(toAbsolute(path)),
    ).pipe(Effect.map((found) => found.repos)),
} satisfies EffectHandlers<
  typeof fsContract,
  unknown,
  Engine.Services | ChildProcessSpawner.ChildProcessSpawner
>;
