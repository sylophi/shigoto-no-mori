// Carry-over: the files a new worktree gets beyond its checkout. The
// project's own entries (a symlink or a copy each) merged with what
// every checkout's .worktreeinclude names among its gitignored files,
// looked up across the project's checkouts and applied best effort into
// the new worktree, with directory symlinks hidden from git.
import { isSafeRelPath } from "@shigomori/contracts/predicates/relPath";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Darwin from "./Darwin.ts";
import { copyFailure, copyTree, entryExists } from "./entries.ts";
import * as Git from "./Git.ts";

export type CarryOverEntry = {
  readonly path: string;
  readonly mode: "copy" | "symlink";
};

type CarryOverFailure = {
  readonly path: string;
  readonly reason: string;
  // The checkout the failure is about, when it isn't the primary.
  readonly source?: string;
};

// The report `sm --json` prints for the carry-over step. `sourced` names
// the entries found in a checkout other than the primary, and whether a
// symlink entry was copied instead (links only ever target the primary,
// since a sibling can be torn down).
export type CarryOverReport = {
  readonly applied: number;
  readonly failures: ReadonlyArray<CarryOverFailure>;
  readonly includeFailures?: ReadonlyArray<CarryOverFailure>;
  readonly sourced?: ReadonlyArray<{
    readonly path: string;
    readonly source: string;
    readonly copiedInstead?: true;
  }>;
};

// A checkout carry-over may look in.
export type Source = {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly isPrimary: boolean;
  readonly detached: boolean;
};

export const WORKTREE_INCLUDE = ".worktreeinclude";

export class CarryOver extends Context.Service<
  CarryOver,
  {
    // Applies the project's carry-over to the worktree at `destination`,
    // looking in `checkouts` (the project's, the destination left out)
    // in order: the one on the `base` branch, the primary, the rest by
    // name. None when there is nothing to carry.
    readonly apply: (input: {
      readonly repo: string;
      readonly settings: Readonly<Record<string, unknown>> | null;
      readonly checkouts: ReadonlyArray<Source>;
      readonly destination: string;
      readonly base: string;
    }) => Effect.Effect<Option.Option<CarryOverReport>>;
  }
>()("sm/engine/CarryOver") {}

// The project's own entries, those that parse.
const manualEntries = (
  settings: Readonly<Record<string, unknown>> | null,
): ReadonlyArray<CarryOverEntry> => {
  const entries = settings?.["carryOver"];
  return Array.isArray(entries)
    ? entries.flatMap((entry) =>
        Predicate.isObject(entry) &&
        typeof entry["path"] === "string" &&
        // Never anywhere but inside the worktree, whatever was synced.
        isSafeRelPath(entry["path"]) &&
        (entry["mode"] === "copy" || entry["mode"] === "symlink")
          ? [{ path: entry["path"], mode: entry["mode"] }]
          : [],
      )
    : [];
};

// The integration is opt-out: absent means on.
const includeEnabled = (settings: Readonly<Record<string, unknown>> | null) =>
  settings?.["useWorktreeInclude"] !== false;

// Duplicate and trailing separators folded, as stored entries are
// compared against git's output.
const normalizeRelPath = (path: string) =>
  path
    .split("/")
    .filter((part) => part !== "")
    .join("/");

const overlap = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// The project's entries win over included ones that collide or overlap
// with them.
const mergeCarryOver = (
  manual: ReadonlyArray<CarryOverEntry>,
  include: ReadonlyArray<CarryOverEntry>,
): ReadonlyArray<CarryOverEntry> => {
  const taken = manual.map((entry) => normalizeRelPath(entry.path));
  return [
    ...manual,
    ...include.filter(
      (entry) => !taken.some((path) => overlap(entry.path, path)),
    ),
  ];
};

// gitPaths.ts makeIgnoreMatcher: the path, its directory form, or a
// fully ignored ancestor directory.
const ignoreMatcher = (paths: ReadonlyArray<string>) => {
  const set = new Set(paths);
  return (relative: string) => {
    if (relative === "") return false;
    if (set.has(relative) || set.has(`${relative}/`)) return true;
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (set.has(`${parts.slice(0, i).join("/")}/`)) return true;
    }
    return false;
  };
};

// Where entries are looked up, in order: the checkout on the base
// branch (its ignored files are the ones a branch from it expects), the
// primary, then the rest by name. The destination is never a source.
export const orderSources = (
  checkouts: ReadonlyArray<Source>,
  destination: string,
  baseBranch: string,
): ReadonlyArray<Source> => {
  const rank = (source: Source) =>
    baseBranch !== "" && !source.detached && source.branch === baseBranch
      ? 0
      : source.isPrimary
        ? 1
        : 2;
  return checkouts
    .filter((source) => source.path !== destination)
    .toSorted(
      (a, b) =>
        rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
};

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const darwin = yield* Darwin.Darwin;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const exists = (file: string) => entryExists(fs, file);

  // What a checkout's .worktreeinclude names among its gitignored files,
  // always copied. None when the file isn't there.
  const resolveInclude = (checkout: string) =>
    Effect.gen(function* () {
      const includePath = path.join(checkout, WORKTREE_INCLUDE);
      if (!(yield* exists(includePath))) return [];
      const candidates = yield* git.listUntrackedMatching(
        checkout,
        includePath,
      );
      if (candidates.length === 0) return [];
      const isIgnored = ignoreMatcher(yield* git.listIgnoredPaths(checkout));
      return candidates.flatMap((candidate): CarryOverEntry[] => {
        const relative = candidate.replace(/\/$/, "");
        return relative !== "" && isIgnored(relative) && isSafeRelPath(relative)
          ? [{ path: relative, mode: "copy" }]
          : [];
      });
    });

  // Every checkout's own .worktreeinclude, resolved against that
  // checkout's gitignore and unioned in source order. A broken file in
  // one checkout is reported and skipped.
  const resolveIncludes = (sources: ReadonlyArray<Source>) =>
    Effect.forEach(
      sources,
      (source) => Effect.result(resolveInclude(source.path)),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((results) => {
        let entries: ReadonlyArray<CarryOverEntry> = [];
        const failures: CarryOverFailure[] = [];
        results.forEach((result, index) => {
          const source = sources[index] as Source;
          if (Result.isFailure(result)) {
            failures.push({
              path: WORKTREE_INCLUDE,
              reason:
                result.failure instanceof Git.GitCommandError
                  ? Git.stderrOf(result.failure)
                  : result.failure.message,
              ...(source.isPrimary ? {} : { source: source.name }),
            });
          } else {
            entries = mergeCarryOver(entries, result.success);
          }
        });
        return { entries, failures };
      }),
    );

  // A copy-on-write clone of the tree where the volume can, else `cp -R
  // -P`. The destination must not exist.
  const cloneOrCopy = (from: string, to: string) =>
    Effect.gen(function* () {
      const cloned = yield* darwin.clone({ from, to }).pipe(
        Stream.runCollect,
        Effect.map((entries) => entries.find(Darwin.isFailed)),
        Effect.orElseSucceed(() => ({ error: { code: "", message: "" } })),
      );
      if (cloned === undefined) return;
      if (cloned.error.code === "EEXIST") {
        return yield* Effect.fail(cloned.error.message);
      }
      // Anything at the destination is the failed clone's leftover.
      yield* fs
        .remove(to, { recursive: true, force: true })
        .pipe(Effect.mapError((error) => error.message));
      yield* copyTree(spawner, from, to).pipe(Effect.mapError(copyFailure));
    });

  // The entry from the first source that has it. Answers the failure,
  // the path to hide from git (a directory symlink), and the source.
  const applyOne = (
    sources: ReadonlyArray<Source>,
    destination: string,
    entry: CarryOverEntry,
  ) =>
    Effect.gen(function* () {
      let found: { source: Source; isDirectory: boolean } | undefined;
      for (const source of sources) {
        const info = yield* fs
          .stat(path.join(source.path, entry.path))
          .pipe(Effect.option);
        if (Option.isSome(info)) {
          found = { source, isDirectory: info.value.type === "Directory" };
          break;
        }
      }
      if (!found) {
        return {
          failure: "Source missing in every checkout",
          exclude: undefined,
          source: undefined,
        };
      }
      const { source, isDirectory } = found;
      const from = path.join(source.path, entry.path);
      const to = path.join(destination, entry.path);
      const outcome = yield* Effect.gen(function* () {
        yield* fs
          .makeDirectory(path.dirname(to), { recursive: true })
          .pipe(Effect.mapError((error) => error.message));
        // No overwrite of files git just laid down.
        if (yield* exists(to)) {
          return yield* Effect.fail("Destination already exists");
        }
        if (entry.mode === "symlink" && source.isPrimary) {
          // Absolute, so the link survives the worktree moving.
          yield* fs
            .symlink(from, to)
            .pipe(Effect.mapError((error) => error.message));
          return isDirectory ? entry.path : undefined;
        }
        yield* cloneOrCopy(from, to);
        return undefined;
      }).pipe(Effect.result);
      return Result.isSuccess(outcome)
        ? { failure: undefined, exclude: outcome.success, source }
        : { failure: outcome.failure, exclude: undefined, source };
    });

  const apply = Effect.fn("CarryOver.apply")(function* (input: {
    readonly repo: string;
    readonly settings: Readonly<Record<string, unknown>> | null;
    readonly checkouts: ReadonlyArray<Source>;
    readonly destination: string;
    readonly base: string;
  }) {
    const manual = manualEntries(input.settings);
    let sources: ReadonlyArray<Source> = [];
    let include: ReadonlyArray<CarryOverEntry> = [];
    let includeFailures: CarryOverFailure[] = [];
    if (manual.length > 0 || includeEnabled(input.settings)) {
      // The checkout a branch from `base` lands on: `origin/feat` is local
      // `feat` where that exists.
      const baseBranch =
        input.base === ""
          ? ""
          : (yield* git.resolveCheckoutRef(input.repo, input.base)).target;
      sources = orderSources(input.checkouts, input.destination, baseBranch);
      if (includeEnabled(input.settings)) {
        const resolved = yield* resolveIncludes(sources);
        include = resolved.entries;
        includeFailures = resolved.failures;
      }
    }
    const entries = mergeCarryOver(manual, include);
    if (entries.length === 0 && includeFailures.length === 0) {
      return Option.none();
    }
    const failures: CarryOverFailure[] = [];
    const sourced: Array<{
      path: string;
      source: string;
      copiedInstead?: true;
    }> = [];
    const excludes: string[] = [];
    for (const entry of entries) {
      const outcome = yield* applyOne(sources, input.destination, entry);
      const sibling = outcome.source !== undefined && !outcome.source.isPrimary;
      if (outcome.failure !== undefined) {
        failures.push({
          path: entry.path,
          reason: outcome.failure,
          ...(sibling ? { source: outcome.source?.name ?? "" } : {}),
        });
      } else if (sibling) {
        sourced.push({
          path: entry.path,
          source: outcome.source?.name ?? "",
          ...(entry.mode === "symlink" ? { copiedInstead: true as const } : {}),
        });
      }
      if (outcome.exclude !== undefined) excludes.push(outcome.exclude);
    }
    yield* git.appendExcludes(input.destination, excludes);
    return Option.some({
      applied: entries.length - failures.length,
      failures,
      ...(includeFailures.length > 0 ? { includeFailures } : {}),
      ...(sourced.length > 0 ? { sourced } : {}),
    });
  });

  return CarryOver.of({ apply });
});

export const layer = Layer.effect(CarryOver, make);
