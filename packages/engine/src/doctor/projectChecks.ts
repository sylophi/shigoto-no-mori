// The doctor's project checks: each project's repo, worktrees, scripts, launchers and ports.
import { tildify } from "@shigomori/contracts/projectPaths";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { WORKTREE_INCLUDE } from "../CarryOver.ts";
import * as CloneCheckout from "../CloneCheckout.ts";
import * as Config from "../Config.ts";
import { projectSettingsOf } from "../Config.ts";
import type { ConfigDoc } from "../configDoc.ts";
import {
  fields,
  plural,
  pluralize,
  scriptFileTokens,
  shellWord,
} from "../doctorParse.ts";
import * as Git from "../Git.ts";
import * as Layout from "../Layout.ts";
import * as Paths from "../Paths.ts";
import { errnoText, isNotFound } from "../platformErrors.ts";
import * as Registry from "../Registry.ts";
import type { ListedProject, RegisteredProject } from "../Registry.ts";
import * as WorktreeData from "../WorktreeData.ts";
import { worktreeIdFromPath } from "../worktreeLayout.ts";
import * as Worktrees from "../Worktrees.ts";
import { scriptOf, type WorktreeIdentity } from "../Worktrees.ts";
import * as WtFolder from "../WtFolder.ts";
import { findExecutable } from "../executables.ts";
import { PORT_POOL_CONFIG, parsePortPoolConfig } from "../ports.ts";
import { parsePortPoolDirs } from "../doctorParse.ts";
import {
  type Entry,
  INCOMING_PREFIX,
  INCOMING_REF_STALE_MS,
  MovedWorktreePending,
  type ProjectChecked,
  type StoreServices,
  LeaseRefused,
  WorktreesNotMoved,
  carryOverPaths,
  check,
  errorText,
  isDirMode,
  mtimeOf,
  repairable,
} from "./documents.ts";
import type { ReadsArea } from "./reads.ts";
import type { DataDirChecksArea } from "./dataDirChecks.ts";

export const makeProjectChecks = ({
  reads,
  dataDirChecks,
}: {
  readonly reads: ReadsArea;
  readonly dataDirChecks: DataDirChecksArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const git = yield* Git.Git;
    const { home, binaryName } = paths;
    const {
      capture,
      lstatIn,
      statOf,
      isMissing,
      realPath,
      sameDirectory,
      readText,
    } = reads;
    const { launcherFindings } = dataDirChecks;
    // --- projects ---

    const unregisterHint = (project: ListedProject) =>
      project.source === "terrier"
        ? `\`terrier rm ${project.name}\``
        : `\`${binaryName} projects remove ${project.name}\``;

    // Whether the project's path is a working repo, which every other
    // check needs: its common dir when it is, what is wrong when it isn't.
    const checkProjectRepo = (project: ListedProject) =>
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const info = yield* fs.stat(project.path).pipe(Effect.result);
        if (Result.isFailure(info) && isNotFound(info.failure)) {
          const line = check("Projects", "project-path", project.name);
          if (project.source !== undefined) {
            // Not sm's entry to drop: terrier prune owns it.
            return Result.fail(
              line.warn(
                `${tildify(project.path, home)} is gone, but ${project.source} still lists it`,
                "Restore the directory, or run `terrier prune`.",
              ),
            );
          }
          return Result.fail(
            repairable(
              line.fail(
                `${tildify(project.path, home)} is gone, so every command for this project fails`,
                `If it moved, point the project at it (\`${binaryName} projects relocate ${project.name} <new-path>\`). Otherwise restore the directory, or unregister it (\`${binaryName} projects remove ${project.name}\`).`,
              ),
              {
                prompt: `Unregister ${project.name} (${tildify(project.path, home)} is gone)? Its config under projects/ goes too.`,
                label: `unregistered ${project.name}`,
                destructive: true,
                writesStore: true,
                // The app may have dropped it already.
                apply: registry
                  .unregister(project.id)
                  .pipe(
                    Effect.asVoid,
                    Effect.catchTags({ UnknownProject: () => Effect.void }),
                  ),
              },
            ),
          );
        }
        if (Result.isFailure(info) || info.success.type !== "Directory") {
          return Result.fail(
            check("Projects", "project-path", project.name).fail(
              `${tildify(project.path, home)} isn't a readable directory`,
              `Check its permissions, or unregister it (${unregisterHint(project)}).`,
            ),
          );
        }
        const repo = yield* git.locate(project.path);
        if (Option.isNone(repo)) {
          // A bare repo has no work tree to find, and no primary to compare
          // against. Its linked worktrees are checked like any others.
          const bare = yield* git
            .run(project.path, ["rev-parse", "--is-bare-repository"])
            .pipe(
              Effect.map((stdout) => stdout.trim() === "true"),
              Effect.orElseSucceed(() => false),
            );
          if (bare) return Result.succeed(project.path);
          return Result.fail(
            check("Projects", "project-repo", project.name).fail(
              `${tildify(project.path, home)} is no longer a git repository`,
              `Restore the repo, or unregister it (${unregisterHint(project)}).`,
            ),
          );
        }
        const { primaryPath, commonDir } = repo.value;
        if (primaryPath === project.path) return Result.succeed(commonDir);
        // git answers with a symlink-free path, and everything in sm
        // matches against it, so both ways this can differ are breakage.
        const detail = (yield* sameDirectory(project.path, primaryPath))
          ? `registered through a symlinked path; git calls the same directory ${tildify(primaryPath, home)}, so nothing run from inside the repo matches it`
          : `registered at ${tildify(project.path, home)}, which is a worktree of ${tildify(primaryPath, home)}, not the repo's primary checkout`;
        const readd =
          project.source === "terrier"
            ? `\`terrier add ${tildify(primaryPath, home)}\``
            : `\`${binaryName} projects add ${tildify(primaryPath, home)}\``;
        return Result.fail(
          check("Projects", "project-primary", project.name).fail(
            detail,
            `Unregister it (${unregisterHint(project)}) and re-add the resolved path (${readd}).`,
          ),
        );
      });

    // Where git last saw the linked checkout now at `dir`: its admin dir's
    // gitdir file records "<checkout>/.git".
    const recordedWorktreePath = (dir: string) =>
      Effect.gen(function* () {
        const admin = yield* git.adminDirOf(dir);
        if (Option.isNone(admin)) return "";
        const raw = yield* readText(path.join(admin.value, "gitdir"));
        const recorded = Option.getOrElse(raw, () => "").trim();
        if (recorded === "") return "";
        // worktree.useRelativePaths
        return path.dirname(
          path.isAbsolute(recorded)
            ? recorded
            : path.join(admin.value, recorded),
        );
      });

    // Folders in the managed layout git has no record of, sorted.
    const strayDirs = (
      project: RegisteredProject,
      bases: ReadonlyArray<string>,
      known: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        const strays: string[] = [];
        for (const base of bases) {
          const entries = yield* fs.readDirectory(base).pipe(Effect.option);
          if (Option.isNone(entries)) continue;
          for (const [name, entry] of yield* lstatIn(base, entries.value)) {
            const dir = path.join(base, name);
            if (known.has(dir) || !isDirMode(entry.mode)) continue;
            // A sibling project with the same folder name shares a managed
            // base, so only a stray whose metadata points back here counts.
            const repo = yield* git.locate(dir);
            if (
              Option.isSome(repo) &&
              repo.value.primaryPath !== project.path
            ) {
              continue;
            }
            strays.push(dir);
          }
        }
        return strays.toSorted();
      });

    // How git's worktree metadata and the disk disagree: checkouts git
    // lists whose folder is gone (a locked one is kept on purpose), ones
    // moved by hand (old path to new), and folders in the managed layout
    // git has no record of.
    const findDrift = (
      project: RegisteredProject,
      identities: ReadonlyArray<WorktreeIdentity>,
      bases: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const known = new Set(identities.map((id) => id.path));
        const missing: WorktreeIdentity[] = [];
        for (const id of identities) {
          if (!id.locked && (yield* isMissing(id.path))) missing.push(id);
        }
        const gone = new Set(missing.map((id) => id.path));
        const moved = new Map<string, string>();
        const strays: string[] = [];
        for (const stray of yield* strayDirs(project, bases, known)) {
          const old = yield* recordedWorktreePath(stray);
          if (gone.has(old) && !moved.has(old)) {
            moved.set(old, stray);
            continue;
          }
          strays.push(stray);
        }
        return {
          missing: missing.filter((id) => !moved.has(id.path)),
          moved,
          strays,
        };
      });

    // `git worktree repair` on the new paths, then what is kept by id
    // carried from each old path's id to the new one. git repairs each
    // path on its own and fails if any failed, so the ones it did re-link
    // are re-keyed whatever it answers.
    const relink = (
      project: RegisteredProject,
      moved: ReadonlyMap<string, string>,
    ) =>
      Effect.gen(function* () {
        const worktrees = yield* Worktrees.Worktrees;
        const repaired = yield* git
          .run(project.path, ["worktree", "repair", "--", ...moved.values()])
          .pipe(Effect.result);
        const now = Option.getOrElse(
          yield* worktrees.identities(project).pipe(Effect.option),
          () => [],
        );
        for (const [oldPath, newPath] of moved) {
          const resolved = yield* realPath(newPath);
          const found = now.find(
            (id) =>
              id.path === newPath ||
              (Option.isSome(resolved) && id.path === resolved.value),
          );
          if (found === undefined) continue;
          yield* worktrees.rekey(
            project,
            worktreeIdFromPath(oldPath),
            found.path,
          );
        }
        if (Result.isFailure(repaired)) return yield* repaired.failure;
      });

    // `git worktree prune`, checked again when it runs: a moved worktree
    // still waiting to be re-linked would be severed by it. What sm keeps
    // per worktree goes with each pruned one, as with `sm rm`, all but a
    // pending dirty capture, which may hold the only copy of some work.
    const prune = (project: ListedProject) =>
      Effect.gen(function* () {
        const worktrees = yield* Worktrees.Worktrees;
        const layout = yield* Layout.Layout;
        const registry = yield* Registry.Registry;
        const data = yield* WorktreeData.WorktreeData;
        const cloneCheckout = yield* CloneCheckout.CloneCheckout;
        const drift = yield* findDrift(
          project,
          yield* worktrees.identities(project),
          yield* layout.managedBases(project),
        );
        if (drift.moved.size > 0) {
          return yield* new MovedWorktreePending({ project: project.name });
        }
        yield* git.pruneWorktrees(project.path);
        for (const { id } of drift.missing) {
          yield* registry.forgetWorktree(id);
          yield* data.forget(project.id, id);
          yield* cloneCheckout.forget(id);
        }
      });

    const checkProjectWorktrees = (
      project: ListedProject,
      identities: Result.Result<ReadonlyArray<WorktreeIdentity>, Git.GitError>,
      bases: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        if (Result.isFailure(identities)) {
          return [
            check("Projects", "project-worktrees", project.name).fail(
              `git can't list this project's worktrees: ${errorText(identities.failure)}`,
              `Run \`git worktree list\` in ${tildify(project.path, home)} to see the failure.`,
            ),
          ];
        }
        const drift = yield* findDrift(project, identities.success, bases);
        const entries: Entry<StoreServices>[] = [];
        if (drift.moved.size > 0) {
          const n = drift.moved.size;
          const shown = [...drift.moved]
            .map(
              ([oldPath, newPath]) =>
                `${path.basename(oldPath)} → ${tildify(newPath, home)}`,
            )
            .toSorted();
          entries.push(
            repairable(
              check("Projects", "project-moved", project.name).warn(
                `${n} worktree${plural(n)} moved without telling git (${shown.join(", ")}), so git lists the old path as missing`,
                "Re-link it (`git worktree repair <new path>`). Never prune it.",
              ),
              {
                prompt: "",
                label: `re-linked ${n} moved worktree${plural(n)} for ${project.name}`,
                destructive: false,
                writesStore: true,
                apply: relink(project, drift.moved),
              },
            ),
          );
        }
        if (drift.missing.length > 0) {
          const shown = drift.missing.map(({ name }) => name);
          entries.push(
            repairable(
              check("Projects", "project-worktrees", project.name).warn(
                `git still lists ${shown.length} worktree${plural(shown.length)} whose directory is gone (${shown.join(", ")})`,
                "Prune the metadata (`git worktree prune`). If one was moved, run `git worktree repair <new path>` instead.",
              ),
              {
                // A checkout moved somewhere doctor doesn't look loses its
                // link to the repo once pruned.
                prompt: `Prune git's record of ${shown.join(", ")} in ${project.name}? Say no if any of them was moved rather than deleted.`,
                label: `pruned git's worktree metadata for ${project.name}`,
                destructive: true,
                writesStore: true,
                apply: prune(project),
              },
            ),
          );
        }
        if (drift.strays.length > 0) {
          const shown = drift.strays.map((stray) => tildify(stray, home));
          entries.push(
            check("Projects", "project-strays", project.name).warn(
              `${shown.length} ${pluralize(shown.length, "directory", "directories")} in the managed layout that git doesn't know about (${shown.join(", ")})`,
              `Adopt it (\`${binaryName} adopt <path>\`) or delete it by hand. ${binaryName} won't guess.`,
            ),
          );
        }
        return entries;
      });

    // The worktrees port-pool covers (managed, with a port-pool config)
    // that hold no lease: one a move's re-lease failed for, or whose
    // provision did. The fix asks port-pool for one, at its path.
    // The folders port-pool holds a lease for, symlinks resolved, read
    // once a run; none when port-pool is off, missing or can't say (the
    // ports check reports that).
    const listAllocations = Effect.gen(function* () {
      const device =
        (yield* (yield* Config.Config).read({ kind: "device" })) ?? {};
      if (device["portPool"] !== true) return Option.none();
      if (Option.isNone(yield* findExecutable("port-pool"))) {
        return Option.none();
      }
      const listed = yield* capture("port-pool", ["list"]).pipe(Effect.result);
      if (Result.isFailure(listed) || listed.success.code !== 0) {
        return Option.none();
      }
      const leased = new Set<string>();
      for (const dir of parsePortPoolDirs(listed.success.stdout)) {
        leased.add(dir);
        const real = yield* realPath(dir);
        if (Option.isSome(real)) leased.add(real.value);
      }
      return Option.some(leased as ReadonlySet<string>);
    });

    const checkLeases = (
      project: ListedProject,
      identities: ReadonlyArray<WorktreeIdentity>,
      allocations: typeof listAllocations,
    ) =>
      Effect.gen(function* () {
        const covered: WorktreeIdentity[] = [];
        for (const worktree of identities) {
          if (worktree.isPrimary || worktree.isExternal) continue;
          const config = yield* readText(
            path.join(worktree.path, PORT_POOL_CONFIG),
          );
          if (parsePortPoolConfig(Option.getOrUndefined(config)).configured) {
            covered.push(worktree);
          }
        }
        if (covered.length === 0) return [];
        const allocated = yield* allocations;
        if (Option.isNone(allocated)) return [];
        // A lease held under another spelling of the folder (a symlinked
        // parent) is the worktree's all the same.
        const missing: WorktreeIdentity[] = [];
        for (const worktree of covered) {
          const real = yield* realPath(worktree.path);
          const held =
            allocated.value.has(worktree.path) ||
            (Option.isSome(real) && allocated.value.has(real.value));
          if (!held) missing.push(worktree);
        }
        if (missing.length === 0) return [];
        const names = missing.map((worktree) => path.basename(worktree.path));
        const label = `${missing.length} worktree${plural(missing.length)}`;
        return [
          repairable(
            check("Projects", "project-leases", project.name).warn(
              `${label} port-pool covers ${missing.length === 1 ? "holds" : "hold"} no ports (${names.join(", ")}), so ${missing.length === 1 ? "its" : "their"} servers bind elsewhere`,
              "Run the fix, which asks port-pool to lease them.",
            ),
            {
              prompt: "",
              label: `leased ports for ${label} of ${project.name}`,
              destructive: false,
              apply: Effect.forEach(
                missing,
                (worktree) =>
                  Effect.flatMap(
                    capture("port-pool", ["ensure", worktree.path]),
                    ({ code }) =>
                      code === 0
                        ? Effect.void
                        : Effect.fail(
                            new LeaseRefused({
                              worktree: path.basename(worktree.path),
                              code,
                            }),
                          ),
                  ),
                { discard: true },
              ),
            },
          ),
        ];
      });

    // The v2 worktrees the v3 migration couldn't move into `wt/`, each
    // with why, and the move tried again.
    const checkWtMoves = (project: ListedProject) =>
      Effect.gen(function* () {
        const folder = yield* WtFolder.WtFolder;
        const unmoved = (yield* folder.unmoved).filter(
          (row) => row.projectId === project.id,
        );
        if (unmoved.length === 0) return [];
        const n = unmoved.length;
        const shown = unmoved.map(
          ({ fromPath, error }) =>
            `${tildify(fromPath, home)}${error === null ? "" : ` (${error})`}`,
        );
        return [
          repairable<StoreServices>(
            check("Projects", "project-wt-moves", project.name).warn(
              `${n} worktree${plural(n)} still in a v2 folder, not moved into wt/: ${shown.join(", ")}`,
              "Clear what stopped the move (unlock it, finish the operation, move the existing folder aside), then run the fix to try again.",
            ),
            {
              prompt: "",
              label: `moved ${n} worktree${plural(n)} into wt/ for ${project.name}`,
              destructive: false,
              writesStore: true,
              apply: Effect.gen(function* () {
                const left = yield* folder.retry(project.id);
                if (left.length > 0) {
                  return yield* new WorktreesNotMoved({
                    why: left
                      .map(
                        ({ fromPath, error }) =>
                          `${tildify(fromPath, home)}: ${error ?? "not moved"}`,
                      )
                      .join(", "),
                  });
                }
              }),
            },
          ),
        ];
      });

    // Lifecycle scripts fail late and loudly, mid-create. A script naming
    // a file that isn't in the repo is the common cause, and checkable
    // without running anything.
    const checkProjectScripts = (
      project: ListedProject,
      settings: ConfigDoc | null,
    ) =>
      Effect.gen(function* () {
        if (settings === null) return [];
        const line = check("Projects", "project-scripts", project.name);
        const entries: Entry[] = [];
        for (const slot of ["setup", "teardown"] as const) {
          for (const { token, relative } of scriptFileTokens(
            scriptOf(settings, slot),
          )) {
            if (!(yield* isMissing(path.join(project.path, relative))))
              continue;
            entries.push(
              line.warn(
                `the ${slot} script runs ${token}, which isn't in the repo`,
                `Fix it with \`${binaryName} projects config --${slot} '<command>' -p ${project.name}\`.`,
              ),
            );
          }
        }
        return entries;
      });

    // .worktreeinclude drives carry-over into every new worktree. A broken
    // one doesn't fail create: it degrades to nothing carried over, which
    // looks like the feature is off.
    const checkWorktreeInclude = (
      project: ListedProject,
      settings: ConfigDoc | null,
    ) =>
      Effect.gen(function* () {
        const line = check("Projects", "project-include", project.name);
        const file = path.join(project.path, WORKTREE_INCLUDE);
        const entry = (yield* lstatIn(project.path, [WORKTREE_INCLUDE])).get(
          WORKTREE_INCLUDE,
        );
        if (entry === undefined) return [];
        if (isDirMode(entry.mode)) {
          return [
            line.warn(
              `${WORKTREE_INCLUDE} is a directory, so carry-over resolves nothing`,
              `Remove or replace ${tildify(file, home)}.`,
            ),
          ];
        }
        const readable = yield* fs
          .access(file, { readable: true })
          .pipe(Effect.result);
        if (Result.isFailure(readable)) {
          return [
            line.warn(
              `${WORKTREE_INCLUDE} can't be read (open ${file}: ${errnoText(readable.failure)}), so nothing is carried into new worktrees`,
              `Fix the permissions on ${tildify(file, home)}.`,
            ),
          ];
        }
        // The integration is opt-out: absent means on.
        if (settings?.["useWorktreeInclude"] === false) return [];
        const resolved = yield* git
          .listUntrackedMatching(project.path, file)
          .pipe(
            Effect.flatMap((candidates) =>
              candidates.length === 0
                ? Effect.void
                : git.listIgnoredPaths(project.path),
            ),
            Effect.result,
          );
        if (Result.isSuccess(resolved)) return [];
        return [
          line.warn(
            `${WORKTREE_INCLUDE} doesn't resolve: ${errorText(resolved.failure)}`,
            "Check its patterns against `git ls-files --others`.",
          ),
        ];
      });

    // A carry-over entry no checkout has fails every create after the
    // worktree already exists.
    const checkCarryOver = (
      project: ListedProject,
      settings: ConfigDoc | null,
      checkouts: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const missing: string[] = [];
        for (const entry of carryOverPaths(settings)) {
          let found = false;
          for (const checkout of checkouts) {
            if (Option.isSome(yield* statOf(path.join(checkout, entry)))) {
              found = true;
              break;
            }
          }
          if (!found) missing.push(entry);
        }
        const [first] = missing;
        if (first === undefined) return [];
        const n = missing.length;
        return [
          check("Projects", "project-carryover", project.name).warn(
            `carry-over ${pluralize(n, "entry", "entries")} ${missing.join(", ")}${pluralize(n, " is", " are")} in no checkout, so new worktrees start without ${pluralize(n, "it", "them")}`,
            `Restore it in the primary checkout, or drop the entry (\`${binaryName} projects config carryover rm ${shellWord(first)} -p ${project.name}\`).`,
          ),
        ];
      });

    // Landing refs older than an hour. A ref has no timestamp, so its age
    // is the loose ref file's mtime. A packed one has been through a gc
    // and is old by definition. One in neither (reftable) is left alone.
    const staleIncomingRefs = (repo: string, commonDir: string) =>
      Effect.gen(function* () {
        const listed = yield* git
          .run(repo, ["for-each-ref", "--format=%(refname)", INCOMING_PREFIX])
          .pipe(Effect.orElseSucceed(() => ""));
        if (listed.trim() === "") return [];
        const packed = Option.getOrElse(
          yield* readText(path.join(commonDir, "packed-refs")),
          () => "",
        );
        const now = yield* Clock.currentTimeMillis;
        const stale: string[] = [];
        for (const ref of fields(listed)) {
          const info = yield* statOf(path.join(commonDir, ref));
          if (Option.isSome(info)) {
            if (now - mtimeOf(info.value) >= INCOMING_REF_STALE_MS) {
              stale.push(ref);
            }
          } else if (packed.includes(` ${ref}\n`)) {
            stale.push(ref);
          }
        }
        return stale;
      });

    // refs/shigomori/incoming/<branch> is where a transfer lands a branch
    // before making the worktree, swept straight after. One that outlives
    // its landing blocks every later branch nested under its name.
    const checkIncomingRefs = (project: ListedProject, commonDir: string) =>
      Effect.gen(function* () {
        const stale = yield* staleIncomingRefs(project.path, commonDir);
        if (stale.length === 0) return [];
        const n = stale.length;
        const shown = stale.map((ref) => ref.slice(INCOMING_PREFIX.length));
        return [
          repairable(
            check("Projects", "project-incoming", project.name).warn(
              `${n} transfer landing ref${plural(n)} left by an interrupted transfer (${shown.join(", ")}), which can block the next one`,
              `Delete ${pluralize(n, "it", "them")}. The commits stay on the device they came from.`,
            ),
            {
              prompt: `Delete ${stale.join(", ")} in ${project.name}?`,
              label: `deleted ${n} leftover landing ref${plural(n)} in ${project.name}`,
              destructive: true,
              apply: Effect.forEach(
                stale,
                (ref) =>
                  git.run(project.path, [
                    "update-ref",
                    "-d",
                    "--end-of-options",
                    ref,
                  ]),
                { discard: true },
              ),
            },
          ),
        ];
      });

    // Only problems, none for a healthy project, and its checkouts.
    // `fileLine` is what reading its project.json found, when the store
    // couldn't import it.
    const checkOneProject = (
      project: ListedProject,
      fileLine: Option.Option<Entry>,
      allocations: typeof listAllocations,
    ) =>
      Effect.gen(function* () {
        const repo = yield* checkProjectRepo(project);
        // Every check below needs a working repo.
        if (Result.isFailure(repo)) {
          return {
            entries: [repo.failure],
            identities: Option.none(),
          } satisfies ProjectChecked;
        }
        const config = yield* Config.Config;
        const worktrees = yield* Worktrees.Worktrees;
        const layout = yield* Layout.Layout;
        const stored = yield* config.read({
          kind: "project",
          projectId: project.id,
          path: project.path,
        });
        const { settings, defaultBranch } = projectSettingsOf(stored);
        const identities = yield* worktrees
          .identities(project)
          .pipe(Effect.result);
        const bases = yield* layout.managedBases(project);
        const entries: Entry<StoreServices>[] = [];
        // The app and every command read a stored document with no default
        // branch as none, so its scripts and layout stop applying.
        if (Option.isSome(fileLine)) {
          entries.push(fileLine.value);
        } else if (stored !== null && settings === null) {
          entries.push(
            check("Projects", "project-config", project.name).warn(
              "project.json exists but is invalid (bad JSON or no defaultBranch), so its scripts and layout are ignored",
              `Run \`${binaryName} projects config --default-branch <ref> -p ${project.name}\` to rewrite it.`,
            ),
          );
        }
        const primaryRef = yield* git.resolveDefaultBranch(
          project.path,
          defaultBranch,
        );
        if (Option.isNone(primaryRef)) {
          entries.push(
            check("Projects", "project-branch", project.name).warn(
              defaultBranch !== undefined
                ? `the configured default branch ${defaultBranch.trim()} doesn't exist, and nothing else resolves either`
                : `no default branch resolves, so create has no base to fork from`,
              `Set one with \`${binaryName} projects config --default-branch <ref> -p ${project.name}\`.`,
            ),
          );
        }
        // Without a listing, carry-over still looks in the primary.
        const checkouts = Result.isSuccess(identities)
          ? identities.success.map((id) => id.path)
          : [project.path];
        entries.push(
          ...(yield* checkProjectWorktrees(project, identities, bases)),
          ...(yield* checkWtMoves(project)),
          ...(Result.isSuccess(identities)
            ? yield* checkLeases(project, identities.success, allocations)
            : []),
          ...(yield* checkProjectScripts(project, settings)),
          ...(yield* checkWorktreeInclude(project, settings)),
          ...(yield* checkCarryOver(project, settings, checkouts)),
          ...(yield* launcherFindings(
            check("Projects", "project-launchers", project.name),
            settings,
            "projects config launcher rm",
            ` -p ${project.name}`,
          )),
          ...(yield* checkIncomingRefs(project, repo.success)),
        );
        return {
          entries,
          identities: Result.isSuccess(identities)
            ? Option.some(identities.success)
            : Option.none(),
        } satisfies ProjectChecked;
      });

    // One line per healthy project and one per problem otherwise, so a
    // dozen projects don't bury the findings under green ticks. A terrier
    // project gets the same checks, all but the unregister repair.
    const checkProjects = (
      projects: ReadonlyArray<ListedProject>,
      projectFiles: ReadonlyMap<string, Entry>,
    ) =>
      Effect.gen(function* () {
        // port-pool's leases, listed once for every project's check.
        const allocations = yield* Effect.cached(listAllocations);
        return yield* Effect.forEach(
          projects,
          (project) =>
            Effect.map(
              checkOneProject(
                project,
                Option.fromUndefinedOr(projectFiles.get(project.id)),
                allocations,
              ),
              ({ entries, identities }) => ({
                project,
                identities,
                entries:
                  entries.length > 0
                    ? entries
                    : [
                        check("Projects", "project", project.name).ok(
                          project.source === undefined
                            ? "ok"
                            : `ok (via ${project.source})`,
                        ),
                      ],
              }),
            ),
          { concurrency: "unbounded" },
        );
      });

    return { checkProjects };
  });

export type ProjectChecksArea = Effect.Success<
  ReturnType<typeof makeProjectChecks>
>;
