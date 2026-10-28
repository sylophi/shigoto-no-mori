// A folder's whole tree watched, its events as a recursive `fs.watch`
// gives them: each path relative to the root. On a Mac that is the one
// recursive watch, since FSEvents watches a tree as one stream. Linux's
// inotify watches a folder at a time, and Node's recursive watch there
// puts a watch on every file of the tree as well, which one worktree's
// dependencies take past the user's limit on watches. So there the tree
// is watched a folder at a time, but for the folders `leaveOut` answers,
// asked a level of the tree at a time, and a folder that appears is
// watched as it appears. A folder left out stays out until the watch
// starts again.
import { readdir } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Predicate from "effect/Predicate";
import type * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { byPlatform } from "@shigomori/engine/platform";
import { log } from "@shared/log";
import { untilWatchable, watchPath } from "./watchPath";

// Of some of the tree's folders (root-relative, `/`-separated), the ones
// not to watch.
export type LeaveOut = (
  folders: ReadonlyArray<string>,
) => Effect.Effect<ReadonlySet<string>>;

export const watchTree = (
  fs: FileSystem.FileSystem,
  root: string,
  leaveOut: LeaveOut,
): Stream.Stream<FileSystem.WatchEvent, PlatformError> =>
  byPlatform({
    darwin: () => watchPath(fs, root, { recursive: true }),
    linux: () => watchFolders(fs, root, leaveOut),
  })();

const under = (folder: string, name: string) =>
  folder === "" ? name : `${folder}/${name}`;

const watchFolders = (
  fs: FileSystem.FileSystem,
  root: string,
  leaveOut: LeaveOut,
) =>
  Stream.callback<FileSystem.WatchEvent, PlatformError>((queue) =>
    Effect.gen(function* () {
      yield* untilWatchable(root);
      const full = (folder: string) =>
        folder === "" ? root : `${root}/${folder}`;
      // Each folder below the root watched, and its watch.
      const watched = yield* FiberMap.make<string>();
      let warned = false;

      // A folder's events, as the root's paths. A folder that appears in
      // it is watched in turn, and one that goes takes its watches along.
      const eventsOf = (folder: string) =>
        fs.watch(full(folder)).pipe(
          Stream.runForEach((event) => {
            const path = under(folder, event.path);
            Queue.offerUnsafe(queue, { ...event, path });
            if (Predicate.isTagged(event, "Remove")) return drop(path);
            if (!Predicate.isTagged(event, "Create")) return Effect.void;
            return fs.stat(full(path)).pipe(
              Effect.flatMap((info) =>
                info.type === "Directory" ? add([path]) : Effect.void,
              ),
              Effect.ignore,
            );
          }),
        );

      // Folders watched, and theirs below them, a level at a time.
      const add = (folders: ReadonlyArray<string>): Effect.Effect<void> =>
        Effect.gen(function* () {
          let level = folders;
          while (level.length > 0) {
            const out = yield* leaveOut(level);
            const next: string[] = [];
            for (const folder of level) {
              if (out.has(folder) || (yield* FiberMap.has(watched, folder))) {
                continue;
              }
              yield* FiberMap.run(
                watched,
                folder,
                // A folder that can't be watched (the user's watches all
                // taken) goes unwatched, said once for the tree.
                eventsOf(folder).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      if (warned) return;
                      warned = true;
                      log.warn(
                        `[watch] ${full(folder)} is not watched, nor maybe others in ${root}: ${error.message}`,
                      );
                    }),
                  ),
                ),
                { onlyIfMissing: true },
              );
              const entries = yield* Effect.promise(() =>
                readdir(full(folder), { withFileTypes: true }).catch(() => []),
              );
              for (const entry of entries) {
                if (entry.isDirectory()) next.push(under(folder, entry.name));
              }
            }
            level = next;
          }
        });

      const drop = (path: string) =>
        Effect.forEach(
          [...watched].filter(
            ([folder]) => folder === path || folder.startsWith(`${path}/`),
          ),
          ([folder]) => FiberMap.remove(watched, folder),
          { discard: true },
        );

      // The root's watch is the tree's: its end, or its failure, ends it.
      const rootWatch = yield* Effect.forkScoped(eventsOf(""));
      const entries = yield* Effect.promise(() =>
        readdir(root, { withFileTypes: true }).catch(() => []),
      );
      yield* add(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      );
      yield* Fiber.join(rootWatch);
      yield* Queue.end(queue);
    }),
  );
