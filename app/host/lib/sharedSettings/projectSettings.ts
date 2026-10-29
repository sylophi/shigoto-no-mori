// A project's synced settings (contracts' SYNCED_PROJECT_SETTINGS)
// follow its repo to every device holding it while the repo's sync is
// on (Configure's "All devices" tab), through the shared settings:
// turning it on carries the settings of the project it was turned on
// for, an edit made anywhere after is stamped there (engine Config.ts),
// and each device takes the entries of its projects' repos into their
// settings. Matched by repo identity, so two checkouts of one repo here
// take the same settings too.
import type { ProjectRow } from "@shigomori/contracts/schemas";
import {
  anyProjectSettingsSync,
  projectSettingsSnapshot,
  projectSettingsSync,
  sharedSettingKeys,
  syncedProjectSettingsPatch,
} from "@shigomori/contracts/sharedSettings";
import * as Git from "@shigomori/engine/Git";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Ops from "../engineOps";
import { refresh } from "../projects";
import {
  onSharedSettingsChange,
  sharedSettingsCopy,
  sharedSettingsLoaded,
} from "./store";

export const switchSync = Effect.fnUntraced(function* (
  projectId: string,
  on: boolean,
) {
  yield* sharedSettingsLoaded;
  const identity = yield* Ops.projectRepoIdentity(projectId);
  if (identity === null) return;
  const local = yield* Ops.readSyncedProjectValues(projectId);
  const key = sharedSettingKeys.projectSettingsSync(identity);
  const sync = sharedSettingsCopy.set(key, on ? true : null).entries[key];
  if (on && sync !== undefined) {
    sharedSettingsCopy.merge(projectSettingsSnapshot(identity, local, sync));
  }
});

const level = Effect.fnUntraced(function* (row: ProjectRow) {
  if (row.identity === null || !row.pathExists) return;
  const doc = sharedSettingsCopy.read();
  if (projectSettingsSync(doc, row.identity) === undefined) return;
  const local = yield* Ops.readSyncedProjectValues(row.id);
  const { defaultBranch, ...patch } = syncedProjectSettingsPatch(
    doc,
    row.identity,
    local,
  );
  // Only a branch this checkout has: one on a remote it lacks keeps the
  // one it has.
  const branchHere =
    defaultBranch !== undefined &&
    (yield* (yield* Git.Git).hasCommit(row.path, defaultBranch));
  const taken = branchHere ? { ...patch, defaultBranch } : patch;
  if (Object.keys(taken).length === 0) return;
  yield* Ops.patchProjectConfig(row.id, taken, { stamp: false });
});

// Every project leveled once the copy is read, then again whenever the
// copy moves or a project comes or goes, while any repo's sync is on.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const changes = yield* (yield* StoreChanges.StoreChanges).subscribe;
    const wake = yield* Latch.make(true);
    // The projects' identities cost git a few runs each, so they are
    // read again only when the projects change.
    let relist = true;
    let rows: readonly ProjectRow[] = [];
    yield* Effect.acquireRelease(
      Effect.sync(() => onSharedSettingsChange(() => wake.openUnsafe())),
      (stop) => Effect.sync(stop),
    );
    yield* changes.pipe(
      Stream.filter((tables) => tables.has("projects")),
      Stream.runForEach(() =>
        Effect.sync(() => {
          relist = true;
          wake.openUnsafe();
        }),
      ),
      Effect.forkScoped,
    );
    yield* sharedSettingsLoaded.pipe(
      Effect.andThen(
        Effect.forever(
          Effect.gen(function* () {
            yield* wake.await;
            yield* wake.close;
            if (!anyProjectSettingsSync(sharedSettingsCopy.read())) return;
            if (relist) {
              rows = yield* refresh;
              relist = false;
            }
            yield* Effect.forEach(
              rows,
              (row) =>
                level(row).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[settings] couldn't level ${row.name}'s synced settings`,
                      cause,
                    ),
                  ),
                ),
              { discard: true },
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "[settings] couldn't list the projects to level",
                cause,
              ),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
