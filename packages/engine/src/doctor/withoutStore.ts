// The doctor's checks that need no state, for a data dir the store won't open.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Paths from "../Paths.ts";
import { collapseHome } from "../shellHook.ts";
import { stagingHolder } from "../stagingLock.ts";
import { type RunInput, check } from "./documents.ts";
import type { DataDirChecksArea } from "./dataDirChecks.ts";
import type { ChecklistArea } from "./checklist.ts";

export const makeWithoutStore = ({
  dataDirChecks,
  checklist,
}: {
  readonly dataDirChecks: DataDirChecksArea;
  readonly checklist: ChecklistArea;
}) =>
  Effect.gen(function* () {
    const paths = yield* Paths.Paths;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const { home, dataDir } = paths;
    const {
      checkDataDir,
      checkStaleLocks,
      stagingLock,
      checkStagingLock,
      checkUpdateLeftovers,
    } = dataDirChecks;
    const { checkEnvironment, checkProcesses } = checklist;
    // --- without the store ---

    // The checks that need no state: the environment, the data dir's own
    // lines (locks and what an update left) and what a crash left running.
    // `failed` says the store wouldn't open, which is a line of its own
    // unless the data dir's line already says why. Skipped, since they
    // read what the store keeps: config.json's and registry.json's lines,
    // the port pool, launchers, terrier, dormant state, worktree marks and
    // every project.
    const checkWithoutState = (input: RunInput, failed: boolean) =>
      Effect.gen(function* () {
        const environment = yield* checkEnvironment(input);
        const dir = yield* checkDataDir;
        const processes = yield* checkProcesses;
        if (!dir.usable) return [...environment, dir.entry, ...processes];
        const holder = yield* stagingHolder(stagingLock);
        return [
          ...environment,
          dir.entry,
          ...(failed && dir.entry.status !== "fail"
            ? [
                check("Data dir", "store", "store").fail(
                  `${collapseHome(home, paths.store)} can't be opened, so no command can run`,
                  `Check the permissions on ${collapseHome(home, dataDir)}.`,
                ),
              ]
            : []),
          yield* checkStaleLocks,
          ...checkStagingLock(holder),
          ...(yield* checkUpdateLeftovers(input.version, holder)),
          ...processes,
        ];
      }).pipe(Effect.provideContext(platform));

    return { checkWithoutState };
  });

export type WithoutStoreArea = Effect.Success<
  ReturnType<typeof makeWithoutStore>
>;
