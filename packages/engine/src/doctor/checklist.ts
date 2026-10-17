// The doctor's checklist: every check in order, given the store's services.
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Config from "../Config.ts";
import { stagingHolder } from "../stagingLock.ts";
import * as Terrier from "../Terrier.ts";
import * as WorktreeData from "../WorktreeData.ts";
import {
  type Entry,
  type FileReads,
  type RunInput,
  check,
  findingOf,
  listProjects,
} from "./documents.ts";
import type { EnvironmentChecksArea } from "./environmentChecks.ts";
import type { DataDirChecksArea } from "./dataDirChecks.ts";
import type { LeftoverChecksArea } from "./leftoverChecks.ts";
import type { ProjectChecksArea } from "./projectChecks.ts";
import type { ReadsArea } from "./reads.ts";

export const makeChecklist = ({
  reads,
  environmentChecks,
  dataDirChecks,
  leftoverChecks,
  projectChecks,
}: {
  readonly reads: ReadsArea;
  readonly environmentChecks: EnvironmentChecksArea;
  readonly dataDirChecks: DataDirChecksArea;
  readonly leftoverChecks: LeftoverChecksArea;
  readonly projectChecks: ProjectChecksArea;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const { checkGit, checkGh, checkApp, checkPath, checkShellHook } =
      environmentChecks;
    const {
      checkDataDir,
      checkGlobalConfig,
      checkRegistry,
      checkStaleLocks,
      checkV2Files,
      stagingLock,
      checkStagingLock,
      checkUpdateLeftovers,
      checkPortAllocations,
      launcherFindings,
      checkTerrier,
      checkDormantState,
      checkBookkeeping,
    } = dataDirChecks;
    const { checkOrphanTunnel, checkOrphanScripts } = leftoverChecks;
    const { checkProjects } = projectChecks;
    // --- the run ---

    const checkEnvironment = (input: RunInput) =>
      Effect.gen(function* () {
        return [
          yield* checkGit,
          yield* checkGh,
          yield* checkApp(input),
          yield* checkPath,
          yield* checkShellHook(input.terminal),
        ];
      });

    const checkProcesses = Effect.gen(function* () {
      return [...(yield* checkOrphanTunnel), ...(yield* checkOrphanScripts)];
    });

    // Every check. With `files`, the store's services read the 2.x files
    // (`Store.fromFiles`), and the lines that judge those files come from
    // reading them as Go did.
    const checkAll = (input: RunInput, files: Option.Option<FileReads>) =>
      Effect.gen(function* () {
        const terrier = yield* Terrier.Terrier;
        const config = yield* Config.Config;
        const data = yield* WorktreeData.WorktreeData;
        // Read once a pass, and handed to each check that asks.
        const listing = yield* terrier.listing;
        const listed = yield* listProjects(listing);
        const { projects } = listed;
        // A registry that can't be loaded leaves the list short.
        const complete =
          listed.complete &&
          Option.match(files, {
            onNone: () => true,
            onSome: ({ registry }) => registry.status !== "fail",
          });
        const device = (yield* config.read({ kind: "device" })) ?? {};
        const portPool = yield* Effect.cached(
          reads
            .portPoolListing(yield* config.device("portPool"))
            .pipe(Effect.provideContext(platform)),
        );
        const holder = yield* stagingHolder(stagingLock).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
        );
        const kept = yield* data.kept;
        const environment = yield* checkEnvironment(input);
        const dir = yield* checkDataDir;
        const dataDirGroup = dir.usable
          ? [
              dir.entry,
              ...(Option.isSome(files)
                ? [
                    files.value.config,
                    files.value.registry,
                    ...files.value.state,
                    ...files.value.refused,
                  ]
                : [
                    // The store keeps no trace of an empty config.json, so
                    // no settings reads as none.
                    checkGlobalConfig(
                      Option.liftPredicate(
                        device,
                        (doc) => Object.keys(doc).length > 0,
                      ),
                    ),
                    yield* checkRegistry,
                  ]),
              yield* checkStaleLocks,
              // The files the store reads around an import it refused
              // are no leftovers.
              ...(Option.isSome(files) ? [] : yield* checkV2Files),
              ...checkStagingLock(holder),
              ...(yield* checkUpdateLeftovers(input.version, holder)),
              ...(yield* checkPortAllocations(yield* portPool)),
              ...(yield* launcherFindings(
                check("Data dir", "launchers", "launchers"),
                device,
                "config launcher rm",
                "",
              )),
              ...checkTerrier(yield* config.device("terrier"), listing),
              ...(yield* checkDormantState(projects, complete, kept)),
            ]
          : [dir.entry];
        const processes = yield* checkProcesses;
        const checked = yield* checkProjects(
          projects,
          Option.match(files, {
            onNone: () => new Map<string, Entry>(),
            onSome: ({ projectFiles }) => projectFiles,
          }),
          portPool,
        );
        // Last of the data dir's lines, once the projects' checkouts are
        // listed.
        const bookkeeping = dir.usable
          ? yield* checkBookkeeping(
              projects,
              complete,
              new Map(
                checked.flatMap(({ project, identities }) =>
                  Option.isSome(identities)
                    ? [[project.id, identities.value] as const]
                    : [],
                ),
              ),
              kept,
            )
          : [];
        const entries = [
          ...environment,
          ...dataDirGroup,
          ...bookkeeping,
          ...processes,
          ...checked.flatMap(({ entries: found }) => found),
        ];
        // A repair that writes what the store keeps would write the copy
        // in memory, so it is left out.
        return Option.isNone(files)
          ? entries
          : entries.map((entry) =>
              entry.repair?.writesStore === true ? findingOf(entry) : entry,
            );
      }).pipe(Effect.provideContext(platform));

    return { checkEnvironment, checkOrphanTunnel, checkAll };
  });

export type ChecklistArea = Effect.Success<ReturnType<typeof makeChecklist>>;
