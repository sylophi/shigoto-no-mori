// The doctor's data dir checks: where it is, its settings and registry, the store, the updater's leftovers.
import { listed, plural, pluralize } from "@shigomori/contracts/words";
import { tildify } from "@shigomori/contracts/projectPaths";
import { parse } from "semver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Config from "../Config.ts";
import { storedProblem } from "../Config.ts";
import type { ConfigDoc } from "../configDoc.ts";
import { formatSize, launcherProgram, shellWord } from "../doctorParse.ts";
import { findExecutable } from "../executables.ts";
import { flavorNames } from "../flavor.ts";
import * as NativeFs from "../NativeFs.ts";
import * as Paths from "../Paths.ts";
import { isNotFound } from "../platformErrors.ts";
import { byPlatform } from "../platform.ts";
import { heldV2Files, removeV2Files, v2Files } from "../v2Files.ts";
import * as Registry from "../Registry.ts";
import { acquireStagingLock } from "../stagingLock.ts";
import { updaterFiles } from "../Updater.ts";
import type { ListedProject } from "../Registry.ts";
import * as Terrier from "../Terrier.ts";
import * as WorktreeData from "../WorktreeData.ts";
import * as Worktrees from "../Worktrees.ts";
import { type WorktreeIdentity } from "../Worktrees.ts";
import {
  type Entry,
  type Holder,
  LOCK_STALE_MS,
  StagedManifest,
  check,
  errorText,
  isDirMode,
  launcherCommands,
  lstatMtime,
  repairable,
} from "./documents.ts";
import type { PortPoolListing, ReadsArea } from "./reads.ts";

// Terrier's registry is terrier's, and sm only merges it in, so this
// says why merged projects might be missing.
const checkTerrier = (enabled: boolean, listing: Terrier.TerrierListing) => {
  if (!enabled) return [];
  const line = check("Data dir", "terrier", "terrier");
  if (Option.isSome(listing.trouble)) {
    const { summary, advice } = listing.trouble.value;
    return [line.warn(summary, advice)];
  }
  const count = listing.paths.length;
  return [
    line.ok(
      `${pluralize(count, "registered repo")} merged into the project list`,
    ),
  ];
};

// A project's state that no listed project claims is dormant: terrier
// rm of a repo sm held settings for leaves it, since the id is all
// that ties it to a path. Re-registering the path under terrier brings
// back the same id and picks it up again, so dropping it asks first.
const checkDormantState = (
  projects: ReadonlyArray<ListedProject>,
  complete: boolean,
  kept: ReadonlyArray<{ readonly projectId: string }>,
) =>
  Effect.gen(function* () {
    if (!complete) return [];
    const config = yield* Config.Config;
    const data = yield* WorktreeData.WorktreeData;
    const sql = yield* SqlClient.SqlClient;
    const stored = new Set([
      ...(yield* config.storedProjectIds),
      ...kept.map(({ projectId }) => projectId),
    ]);
    if (stored.size === 0) return [];
    const line = check("Data dir", "dormant-state", "project state");
    const claimed = new Set(projects.map(({ id }) => id));
    const dormant = [...stored].filter((id) => !claimed.has(id)).toSorted();
    const [first] = dormant;
    if (first === undefined) {
      return [
        line.ok(
          `${pluralize(stored.size, "state dir")}, each belonging to a project`,
        ),
      ];
    }
    const n = dormant.length;
    const extra = n - 1;
    const label = pluralize(n, "dormant project state");
    return [
      repairable(
        line.warn(
          `${n} state ${plural(n, "dir belongs", "dirs belong")} to no project (${first}${extra > 0 ? ` and ${extra} more` : ""})`,
          "Harmless: it reconnects if terrier lists the repo again (re-added, or the terrier toggle back on). Otherwise delete it.",
        ),
        {
          prompt: `Delete ${label} (${dormant.join(", ")})? Its settings and worktree titles go.`,
          label: `deleted ${label}`,
          destructive: true,
          writesStore: true,
          apply: Effect.forEach(
            dormant,
            (id) =>
              sql
                .withTransaction(
                  Effect.andThen(
                    config.forgetProject(id),
                    data.forgetProject(id),
                  ),
                )
                .pipe(Effect.orDie),
            { discard: true },
          ),
        },
      ),
    ];
  });

// The device's settings, each value checked against the key it sets,
// none when there are none.
const checkGlobalConfig = (
  stored: Option.Option<ConfigDoc>,
  fix = byPlatform({
    darwin: "Set it again in the app's Settings.",
    linux: "Set it again with `config set`.",
  }),
) => {
  const line = check("Data dir", "config", "settings");
  if (Option.isNone(stored)) return line.ok("absent, so defaults apply");
  const device = stored.value;
  const keys = Object.keys(device).length;
  if (storedProblem({ kind: "device" }, device) !== undefined) {
    return line.warn("a setting has the wrong type, so it is ignored", fix);
  }
  return line.ok(`valid, ${pluralize(keys, "key")}`);
};

export const makeDataDirChecks = ({ reads }: { readonly reads: ReadsArea }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const nativeFs = yield* NativeFs.NativeFs;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const { home, dataDir, binaryName, flavor } = paths;
    const names = flavorNames(flavor);
    const {
      lstatIn,
      statOf,
      isDirectory,
      isMissing,
      sameDirectory,
      readText,
      listDir,
    } = reads;
    const sourceText = (() => {
      switch (paths.dataDirSource) {
        case "env":
          return "from SHIGOMORI_DATA_DIR";
        case "pointer":
          return "from the pointer file";
        case "legacy":
          return "pre-2.0 name";
        case "default":
          return `default for the ${flavor} flavor`;
      }
    })();

    const dataDirLine = check("Data dir", "data-dir", "data dir");

    // "/Volumes/<name>" when the path is on a volume that isn't mounted.
    const unmountedVolume = (target: string) =>
      Effect.gen(function* () {
        if (!target.startsWith("/Volumes/")) return "";
        const name = target.slice("/Volumes/".length).split("/")[0] ?? "";
        const volume = `/Volumes/${name}`;
        if (name === "" || Option.isSome(yield* statOf(volume))) return "";
        return volume;
      });

    // ~/<name>, a data dir sm isn't using, still holding state that is
    // now silently ignored.
    const ignoredCopy = (name: string, fix: string) =>
      Effect.gen(function* () {
        const other = path.join(home, name);
        if (
          other === dataDir ||
          (yield* sameDirectory(other, dataDir)) ||
          (yield* paths.holdsState(other)) !== "present"
        ) {
          return Option.none<Entry>();
        }
        return Option.some(
          dataDirLine.warn(
            `${tildify(dataDir, home)} (${sourceText}); ${tildify(other, home)} also holds state and is ignored`,
            fix,
          ),
        );
      });

    // The data dir's line, and whether there is a data dir the other
    // checks can read.
    const checkDataDir = Effect.gen(function* () {
      const shown = `${tildify(dataDir, home)} (${sourceText})`;
      // A pointer that fails the guard is skipped without a word, which
      // reads as every project vanishing.
      if (paths.dataDirSource === "default" && Option.isSome(paths.pointer)) {
        const { file, target, problem } = paths.pointer.value;
        if (target !== "" && problem !== "") {
          return {
            entry: dataDirLine.warn(
              `the pointer file names ${target}, which was ignored because ${problem}, so sm is using ${shown}`,
              `Fix ${tildify(file, home)} to name a data dir, or delete it.`,
            ),
            usable: yield* isDirectory(dataDir),
          };
        }
      }
      const info = yield* fs.stat(dataDir).pipe(Effect.result);
      if (Result.isFailure(info) && isNotFound(info.failure)) {
        const addProject = `\`${binaryName} projects add\``;
        if (paths.dataDirSource !== "pointer") {
          return {
            entry: dataDirLine.warn(
              `${tildify(dataDir, home)} doesn't exist yet (${sourceText}), so nothing is registered`,
              `Add a project (${addProject}) and it will be created.`,
            ),
            usable: false,
          };
        }
        const file = tildify(
          Option.match(paths.pointer, {
            onNone: () => "",
            onSome: (pointer) => pointer.file,
          }),
          home,
        );
        const volume = yield* unmountedVolume(dataDir);
        return {
          entry:
            volume !== ""
              ? dataDirLine.fail(
                  `the pointer file names ${dataDir}, on ${volume}, which isn't connected`,
                  `Connect the drive. To start over on this Mac instead, delete ${file}.`,
                )
              : dataDirLine.warn(
                  `${tildify(dataDir, home)} doesn't exist yet (${sourceText}), so nothing is registered`,
                  `If the data was moved or deleted, fix or delete ${file}. Otherwise add a project (${addProject}) and it will be created.`,
                ),
          usable: false,
        };
      }
      if (Result.isFailure(info)) {
        return {
          entry: dataDirLine.fail(
            `${tildify(dataDir, home)} can't be read: ${info.failure.message}`,
            `Check the permissions on ${tildify(dataDir, home)}.`,
          ),
          usable: false,
        };
      }
      if (info.success.type !== "Directory") {
        return {
          entry: dataDirLine.fail(
            `${tildify(dataDir, home)} is a file, not a directory (${sourceText})`,
            "Move it aside, or point SHIGOMORI_DATA_DIR somewhere else.",
          ),
          usable: false,
        };
      }
      const writable = yield* fs.access(dataDir, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!writable) {
        return {
          entry: dataDirLine.fail(
            `${tildify(dataDir, home)} isn't writable, so no command that changes state can work`,
            "Fix its ownership or permissions.",
          ),
          usable: true,
        };
      }
      if (paths.dataDirSource === "legacy") {
        return {
          entry: dataDirLine.warn(
            shown,
            `Rename it to ~/${names.dataDir} from the app's Settings > Data location.`,
          ),
          usable: true,
        };
      }
      // A data-folder move copies, repoints, then deletes the old copy, so
      // one that died after the repoint leaves the old tree behind. Both
      // names holding state means an upgrade seeded the current one while
      // the old one was unreachable.
      const ignored =
        paths.dataDirSource === "pointer"
          ? yield* ignoredCopy(
              names.dataDir,
              "If a data-folder move left it behind, delete it once you've checked nothing in it is newer.",
            )
          : paths.dataDirSource === "default" && names.legacyDataDir !== null
            ? yield* ignoredCopy(
                names.legacyDataDir,
                "Move it aside, or merge what you need from it by hand.",
              )
            : Option.none<Entry>();
      return {
        entry: Option.getOrElse(ignored, () => dataDirLine.ok(shown)),
        usable: true,
      };
    });

    const configFile = path.join(dataDir, "config.json");
    const registryFile = path.join(dataDir, "registry.json");

    const registryLine = check("Data dir", "registry", "projects");

    // The registry's line, by its projects, and how an incomplete one
    // goes.
    const registeredLine = (
      projects: ReadonlyArray<{
        readonly id?: string | undefined;
        readonly name?: string | undefined;
        readonly path?: string | undefined;
      }>,
      fix: string,
    ) => {
      const malformed = projects.filter(
        ({ id, path: at }) => (id ?? "") === "" || (at ?? "") === "",
      );
      if (malformed.length > 0) {
        const named = malformed.flatMap(({ name }) => (name ? [name] : []));
        return registryLine.warn(
          `${malformed.length} ${plural(malformed.length, "project is", "projects are")} missing an id or path${named.length > 0 ? `: ${named.join(", ")}` : ""}`,
          fix,
        );
      }
      return registryLine.ok(
        `valid, ${pluralize(projects.length, "project")} registered`,
      );
    };

    const checkRegistry = Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      return registeredLine(
        yield* registry.projects,
        `Unregister each with \`${binaryName} projects unregister <name>\`, then add it again.`,
      );
    });

    // Lock files under the data dir older than a write can take: the
    // data dir itself, each project's folder and its worktrees folder,
    // and iconCache/. updates/ holds downloads, never a lock.
    const findStaleLocks = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const stale: string[] = [];
      const scan = (dir: string) =>
        Effect.gen(function* () {
          const locks = (yield* listDir(dir)).filter((name) =>
            name.endsWith(".lock"),
          );
          for (const [name, entry] of yield* lstatIn(dir, locks)) {
            if (
              !isDirMode(entry.mode) &&
              now - lstatMtime(entry) > LOCK_STALE_MS
            ) {
              stale.push(path.join(dir, name));
            }
          }
        });
      yield* scan(dataDir);
      yield* scan(path.join(dataDir, "iconCache"));
      const projectsDir = path.join(dataDir, "projects");
      for (const [name, entry] of yield* lstatIn(
        projectsDir,
        yield* listDir(projectsDir),
      )) {
        if (!isDirMode(entry.mode)) continue;
        const dir = path.join(projectsDir, name);
        yield* scan(dir);
        yield* scan(path.join(dir, "worktrees"));
      }
      return stale.toSorted();
    });

    const removeIfPresent = (target: string) =>
      fs.remove(target).pipe(Effect.catchIf(isNotFound, () => Effect.void));

    const checkStaleLocks = Effect.gen(function* () {
      const line = check("Data dir", "locks", "locks");
      const found = yield* Effect.result(findStaleLocks);
      if (Result.isFailure(found)) {
        return line.warn(
          `can't read the data dir's lock files: ${errorText(found.failure)}`,
          "Run the doctor again. If it keeps failing, reinstall Shigoto no Mori.",
        );
      }
      const locks = found.success;
      const [first] = locks;
      if (first === undefined) return line.ok("no stale lock files");
      const label = pluralize(locks.length, "stale lock file");
      const extra = locks.length - 1;
      return repairable(
        line.warn(
          `${tildify(first, home)} has been held for longer than a write can take${extra > 0 ? ` (and ${extra} more)` : ""}`,
          "Delete it. The process that took it is gone.",
        ),
        {
          prompt: `Delete ${label} (${locks.map((lock) => tildify(lock, home)).join(", ")})?`,
          label: `deleted ${label}`,
          destructive: true,
          apply: Effect.forEach(locks, removeIfPresent, { discard: true }),
        },
      );
    });

    // The files a 2.x data dir kept its state in, which the store holds
    // since its import: what the migration left, when it couldn't verify
    // the import, or what a v2 build started since wrote.
    const v2Context = Context.make(Paths.Paths, paths).pipe(
      Context.merge(platform),
    );
    const checkV2Files = Effect.gen(function* () {
      const files = yield* v2Files.pipe(Effect.provideContext(v2Context));
      if (files.length === 0) return [];
      // Only a file as the import verified it is the store's to replace.
      const sql = yield* SqlClient.SqlClient;
      const held = yield* heldV2Files(files).pipe(
        Effect.provideContext(v2Context),
      );
      const kept = files.filter((file) => !held.includes(file));
      const shownOf = (list: ReadonlyArray<string>) =>
        `${tildify(list[0] ?? "", home)}${list.length > 1 ? ` and ${list.length - 1} more` : ""}`;
      const line = check("Data dir", "v2-files", "v2 files");
      const entries: Entry[] = [];
      if (kept.length > 0) {
        entries.push(
          line.warn(
            `${shownOf(kept)} left from v2, which the store may not hold: the import couldn't verify them, or v2 wrote them since`,
            "Check what they hold, then delete them by hand.",
          ),
        );
      }
      if (held.length > 0) {
        const label = pluralize(held.length, "v2 file");
        entries.push(
          repairable(
            line.warn(
              `${shownOf(held)} left from v2, which the store holds now`,
              "Delete them. Nothing reads them since the import.",
            ),
            {
              prompt: `Delete ${label} (${held.map((file) => tildify(file, home)).join(", ")})?`,
              label: `deleted ${label}`,
              destructive: true,
              // Read again as it runs: a file v2 rewrote since the check
              // stays.
              apply: Effect.flatMap(heldV2Files(held), removeV2Files).pipe(
                Effect.provideContext(v2Context),
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
            },
          ),
        );
      }
      return entries;
    });

    const updater = updaterFiles(path, dataDir);

    // The stager holds its pidfile for a whole download, so a crashed one
    // is told by its pid being dead, not by the file's age.
    const checkStagingLock = (holder: Holder) => {
      const line = check("Data dir", "staging-lock", "update staging");
      if (Option.isNone(holder)) return [];
      const { pid, alive } = holder.value;
      if (alive) return [line.ok(`in progress (pid ${pid})`)];
      return [
        repairable(
          line.warn(
            `left behind by an update that stopped${pid !== 0 ? ` (pid ${pid} is gone)` : ""}, and the next update takes it over`,
            `Delete ${tildify(updater.stagingLock, home)}.`,
          ),
          {
            prompt: `Delete the stale update staging lock at ${tildify(updater.stagingLock, home)}?`,
            label: "deleted the stale update staging lock",
            destructive: true,
            // Through the lock, which breaks only a dead holder's: an
            // update that took it over meanwhile keeps it.
            apply: Effect.scoped(acquireStagingLock(updater.stagingLock)).pipe(
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                spawner,
              ),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            ),
          },
        ),
      ];
    };

    // The scratch a staging run left (the download and its extraction),
    // plus a staged bundle this build already is or is newer than. An
    // unparseable version on either side is "can't tell", never leftover.
    const updateLeftovers = (version: string) =>
      Effect.gen(function* () {
        const found: string[] = [];
        for (const scratch of [updater.download, updater.extract]) {
          if (
            yield* fs.exists(scratch).pipe(Effect.orElseSucceed(() => false))
          ) {
            found.push(scratch);
          }
        }
        const staged = Option.flatMap(
          yield* readText(updater.manifest),
          Schema.decodeOption(StagedManifest),
        );
        const stagedVersion = Option.isSome(staged)
          ? parse(staged.value.version ?? "")
          : null;
        const current = parse(version);
        if (
          stagedVersion !== null &&
          current !== null &&
          stagedVersion.compare(current) <= 0
        ) {
          found.push(updater.staged);
        }
        return found;
      });

    // The bytes of the files under a path, the path itself when a file.
    // A symlink counts as itself, never what it points at. Undefined when
    // any of it can't be read, so no size is shown rather than a short one.
    const treeSize = (root: string) =>
      nativeFs.lstat({ root }).pipe(
        Stream.runFold(
          (): number | undefined => 0,
          (size, entry) =>
            size === undefined || NativeFs.isFailed(entry)
              ? undefined
              : isDirMode(entry.mode)
                ? size
                : size + entry.size,
        ),
        Effect.orElseSucceed(() => undefined),
      );

    // A crashed or superseded update leaves its scratch until the next
    // update sweeps it. Only while no stager holds the lock: mid-run,
    // these are its working files.
    const checkUpdateLeftovers = (version: string, holder: Holder) =>
      Effect.gen(function* () {
        if (Option.isSome(holder) && holder.value.alive) return [];
        const found = yield* updateLeftovers(version);
        if (found.length === 0) return [];
        let size: number | undefined = 0;
        for (const item of found) {
          const one = yield* treeSize(item);
          size =
            size === undefined || one === undefined ? undefined : size + one;
        }
        const shown = size === undefined ? "" : `${formatSize(size)} of `;
        return [
          repairable(
            check("Data dir", "update-leftovers", "update files").warn(
              `${shown}downloads left by an earlier update that nothing will install`,
              "Delete them, or let the next update sweep them.",
            ),
            {
              prompt: `Delete ${shown}leftover update files in ${tildify(updater.updates, home)}?`,
              label: `deleted ${shown}leftover update files`,
              destructive: true,
              // Under the stager's own lock, and listed again once it is
              // held: a run that staged something newer since keeps it.
              apply: Effect.gen(function* () {
                yield* acquireStagingLock(updater.stagingLock).pipe(
                  Effect.provideService(
                    ChildProcessSpawner.ChildProcessSpawner,
                    spawner,
                  ),
                );
                for (const item of yield* updateLeftovers(version)) {
                  yield* fs.remove(item, { recursive: true });
                }
              }).pipe(Effect.scoped, Effect.provideContext(platform)),
            },
          ),
        ];
      });

    // port-pool leases are keyed by directory and live in port-pool's own
    // state. One whose directory is gone stays reserved forever. Reported,
    // never fixed: the state belongs to port-pool.
    const checkPortAllocations = Effect.fnUntraced(function* (
      listing: PortPoolListing,
    ) {
      if (listing.kind === "off") return [];
      const line = check("Data dir", "ports", "port pool");
      if (listing.kind === "missing") {
        return [
          line.warn(
            "on in Settings but `port-pool` isn't on PATH, so provisioning is skipped",
            byPlatform({
              darwin:
                "Install port-pool, or turn the toggle off in the app's Settings.",
              linux: `Install port-pool, or turn it off (\`${paths.binaryName} config set portPool false\`).`,
            }),
          ),
        ];
      }
      if (listing.kind === "failed") {
        return [
          line.warn(
            `\`port-pool list\` failed: ${listing.why}`,
            "Run `port-pool list` by hand to see what it says.",
          ),
        ];
      }
      const { dirs } = listing;
      let orphans = 0;
      for (const dir of dirs) {
        if (yield* isMissing(dir)) orphans++;
      }
      if (orphans === 0) {
        return [
          line.ok(
            `${pluralize(dirs.length, "allocation")}, all pointing at directories that exist`,
          ),
        ];
      }
      return [
        line.warn(
          `${orphans} of ${dirs.length} allocations point at directories that are gone, so those ports stay reserved`,
          `Run \`port-pool prune\` (it owns that state, so ${binaryName} won't touch it).`,
        ),
      ];
    });

    // Custom launchers fire and forget through /bin/sh, so one whose
    // program isn't installed fails with nothing on screen.
    const launcherFindings = (
      line: ReturnType<typeof check>,
      doc: ConfigDoc | null,
      rm: string,
      scope: string,
    ) =>
      Effect.gen(function* () {
        const entries: Entry[] = [];
        for (const { label, command } of launcherCommands(doc)) {
          const program = launcherProgram(command, paths.expandHome);
          if (program === "") continue;
          const present = program.startsWith("/")
            ? Option.isSome(yield* statOf(program))
            : Option.isSome(yield* findExecutable(program));
          if (present) continue;
          entries.push(
            line.warn(
              `the ${label} launcher runs ${program}, which isn't installed or on PATH`,
              `Install it, or fix the launcher (\`${binaryName} ${rm} ${shellWord(label)}${scope}\`, then add it again).`,
            ),
          );
        }
        return entries;
      });

    // Everything kept by worktree id: the marks, the shelf snapshots, the
    // unshelve times and each worktree's data. Removing a worktree clears
    // them, so ids that match nothing mean worktrees were removed outside
    // sm. Harmless, so reported and never cleared. With the project list
    // short, every mark of a missing project would read as a leftover, so
    // it stands down.
    const checkBookkeeping = (
      projects: ReadonlyArray<ListedProject>,
      complete: boolean,
      listings: ReadonlyMap<string, ReadonlyArray<WorktreeIdentity>>,
      kept: ReadonlyArray<{
        readonly projectId: string;
        readonly worktreeId: string;
      }>,
    ) =>
      Effect.gen(function* () {
        if (!complete) return [];
        const registry = yield* Registry.Registry;
        const worktrees = yield* Worktrees.Worktrees;
        const known = new Set<string>();
        const idsOf = new Map<string, ReadonlySet<string>>();
        for (const project of projects) {
          const found = Option.fromUndefinedOr(listings.get(project.id));
          // A project whose checks stopped early is listed here.
          const identities = Option.isSome(found)
            ? found
            : yield* worktrees.identities(project).pipe(Effect.option);
          // An unreadable repo would make every id look orphaned.
          if (Option.isNone(identities)) return [];
          const ids = new Set(identities.value.map(({ id }) => id));
          for (const id of ids) known.add(id);
          idsOf.set(project.id, ids);
        }
        const dataFiles = kept.filter(({ projectId, worktreeId }) => {
          const ids = idsOf.get(projectId);
          return ids !== undefined && !ids.has(worktreeId);
        }).length;
        const sets = Object.values(yield* registry.keptIds);
        const marked = new Set<string>();
        let leftover = 0;
        for (const set of sets) {
          for (const id of set) {
            marked.add(id);
            if (!known.has(id)) leftover++;
          }
        }
        const line = check("Data dir", "bookkeeping", "worktree marks");
        if (leftover === 0 && dataFiles === 0) {
          return marked.size > 0
            ? [
                line.ok(
                  `${pluralize(marked.size, "worktree")} marked, all still present`,
                ),
              ]
            : [];
        }
        const parts = [
          ...(leftover > 0 ? [pluralize(leftover, "mark")] : []),
          ...(dataFiles > 0 ? [pluralize(dataFiles, "data file")] : []),
        ];
        return [
          line.warn(
            `${listed(parts)} ${plural(leftover + dataFiles, "belongs", "belong")} to worktrees that no longer exist`,
            `Harmless, and some may belong to a project that isn't listed right now. Removing worktrees with \`${binaryName} rm\` or from the app leaves none behind.`,
          ),
        ];
      });

    return {
      checkDataDir,
      configFile,
      registryFile,
      checkGlobalConfig,
      registryLine,
      registeredLine,
      checkRegistry,
      checkStaleLocks,
      checkV2Files,
      stagingLock: updater.stagingLock,
      checkStagingLock,
      checkUpdateLeftovers,
      checkPortAllocations,
      launcherFindings,
      checkTerrier,
      checkDormantState,
      checkBookkeeping,
    };
  });

export type DataDirChecksArea = Effect.Success<
  ReturnType<typeof makeDataDirChecks>
>;
