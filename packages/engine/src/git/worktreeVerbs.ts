// Git's worktree verbs: listing, adding, moving and removing linked worktrees.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { canonicalPath } from "../canonicalPath.ts";
import type { CheckoutConfig } from "../gitIndex.ts";
import { parseWorktreeList, splitLines, splitRemoteRef } from "../gitParse.ts";
import { byPlatform } from "../platform.ts";
import { GitCommandError } from "./documents.ts";
import type { RunningArea } from "./running.ts";

// Settings a single git command reads over the repository's.
const configArgs = (config: Readonly<Record<string, string>> = {}) =>
  Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]);

export const makeWorktreeVerbs = ({
  running,
}: {
  readonly running: RunningArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run, succeeds } = running;
    const adminDirOf = Effect.fn("Git.adminDirOf")((worktreePath: string) =>
      fs.readFileString(path.join(worktreePath, ".git")).pipe(
        Effect.map((text) => {
          const trimmed = text.trim();
          if (!trimmed.startsWith("gitdir: ")) return Option.none<string>();
          const dir = canonicalPath(trimmed.slice("gitdir: ".length));
          return Option.some(
            path.isAbsolute(dir) ? dir : path.join(worktreePath, dir),
          );
        }),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
    );

    const listWorktrees = Effect.fn("Git.listWorktrees")(function* (
      repo: string,
    ) {
      return parseWorktreeList(
        yield* run(repo, ["worktree", "list", "--porcelain", "-z"]),
      );
    });

    const addWorktree = Effect.fn("Git.addWorktree")(function* (input: {
      readonly repo: string;
      readonly path: string;
      readonly branch: string;
      readonly base?: string | undefined;
      readonly noCheckout?: boolean | undefined;
      readonly config?: Readonly<Record<string, string>> | undefined;
    }) {
      // A new branch is unpublished: off origin/main, git's default
      // (branch.autoSetupMerge) would track main, where a push of it
      // is refused or lands.
      yield* run(input.repo, [
        ...configArgs(input.config),
        "worktree",
        "add",
        "--no-track",
        "-b",
        input.branch,
        ...(input.noCheckout ? ["--no-checkout"] : []),
        "--",
        input.path,
        ...(input.base ? [input.base] : []),
      ]);
    });

    // A setting as git reads it at `cwd`, empty when unset.
    const configAt = (cwd: string, args: readonly string[]) =>
      run(cwd, ["config", ...args], { okExitCodes: [1] }).pipe(
        Effect.map((out) => out.trim()),
      );

    const checkoutConfig = Effect.fn("Git.checkoutConfig")(function* (
      checkout: string,
    ) {
      const read = (key: string) =>
        Effect.map(configAt(checkout, ["--get", key]), (value) =>
          value.toLowerCase(),
        );
      // git's bool, a value it refuses to read taken as `fallback`.
      const bool = (key: string, fallback: boolean) =>
        configAt(checkout, ["--type=bool", "--get", key]).pipe(
          Effect.map((value) => (value === "" ? undefined : value === "true")),
          Effect.catchIf(
            (error) =>
              error instanceof GitCommandError && error.exitCode === 128,
            () => Effect.succeed(fallback),
          ),
        );
      const { autocrlf, eol, symlinks } = yield* Effect.all(
        {
          autocrlf: read("core.autocrlf"),
          eol: read("core.eol"),
          symlinks: bool("core.symlinks", false),
        },
        { concurrency: "unbounded" },
      );
      // autocrlf also takes "input", which isn't a bool.
      const crlf =
        autocrlf === "input"
          ? "input"
          : autocrlf !== "" && (yield* bool("core.autocrlf", true))
            ? "true"
            : "false";
      return {
        autocrlf: crlf,
        // git reads core.eol only with autocrlf off.
        eol:
          crlf === "true"
            ? "crlf"
            : crlf === "input"
              ? "lf"
              : eol === "lf" || eol === "crlf"
                ? eol
                : byPlatform({
                    darwin: "lf",
                    linux: "lf",
                    win32: "crlf",
                  } as const),
        symlinks: symlinks ?? true,
      } satisfies CheckoutConfig;
    });

    // Settings for `worktree` alone, in its own config.worktree. Turning
    // the repository's extensions.worktreeConfig on first moves what its
    // shared config says of the main worktree alone (core.bare when
    // true, core.worktree) into the main worktree's config.worktree, as
    // git's documentation asks, or every linked worktree would read them.
    const setWorktreeConfig = Effect.fn("Git.setWorktreeConfig")(function* (
      worktree: string,
      entries: Readonly<Record<string, string>>,
    ) {
      const common = canonicalPath(
        (yield* run(worktree, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])).trim(),
      );
      const shared = ["--file", path.join(common, "config")];
      const main = ["--file", path.join(common, "config.worktree")];
      const on = yield* configAt(worktree, [
        ...shared,
        "--type=bool",
        "--get",
        "extensions.worktreeConfig",
      ]);
      if (on !== "true") {
        const bare = yield* configAt(worktree, [
          ...shared,
          "--type=bool",
          "--get",
          "core.bare",
        ]);
        const mainWorktree = yield* configAt(worktree, [
          ...shared,
          "--get",
          "core.worktree",
        ]);
        for (const [key, value] of [
          ["core.bare", bare === "true" ? "true" : ""],
          ["core.worktree", mainWorktree],
        ] as const) {
          if (value === "") continue;
          yield* run(worktree, ["config", ...main, key, value]);
          yield* run(worktree, ["config", ...shared, "--unset", key]);
        }
        yield* run(worktree, [
          "config",
          ...shared,
          "extensions.worktreeConfig",
          "true",
        ]);
      }
      for (const [key, value] of Object.entries(entries)) {
        yield* run(worktree, ["config", "--worktree", key, value]);
      }
    });

    const listRemotes = Effect.fn("Git.listRemotes")(function* (repo: string) {
      return yield* run(repo, ["remote"]).pipe(
        Effect.map(splitLines),
        Effect.orElseSucceed(() => []),
      );
    });

    const localBranchExists = Effect.fn("Git.localBranchExists")(function* (
      repo: string,
      branch: string,
    ) {
      return yield* succeeds(repo, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
    });

    const remoteRefExists = Effect.fn("Git.remoteRefExists")(function* (
      repo: string,
      ref: string,
    ) {
      return yield* succeeds(repo, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/${ref}`,
      ]);
    });

    const resolveCheckoutRef = Effect.fn("Git.resolveCheckoutRef")(function* (
      repo: string,
      ref: string,
      remotes?: readonly string[],
    ) {
      if (yield* localBranchExists(repo, ref)) {
        return { target: ref, track: Option.none<string>() };
      }
      const split = splitRemoteRef(ref, remotes ?? (yield* listRemotes(repo)));
      if (!split) return { target: ref, track: Option.none<string>() };
      if (yield* localBranchExists(repo, split.branch)) {
        return { target: split.branch, track: Option.none<string>() };
      }
      return { target: ref, track: Option.some(split.branch) };
    });

    const checkoutWorktree = Effect.fn("Git.checkoutWorktree")(
      function* (input: {
        readonly repo: string;
        readonly path: string;
        readonly ref: string;
        readonly remotes?: readonly string[] | undefined;
        readonly noCheckout?: boolean | undefined;
        readonly config?: Readonly<Record<string, string>> | undefined;
        // Checked out though another worktree has it, as an adopt's
        // replacement made before the checkout it replaces goes.
        readonly force?: boolean | undefined;
      }) {
        const { target, track } = yield* resolveCheckoutRef(
          input.repo,
          input.ref,
          input.remotes,
        );
        yield* run(input.repo, [
          ...configArgs(input.config),
          "worktree",
          "add",
          ...(input.noCheckout ? ["--no-checkout"] : []),
          ...(input.force ? ["--force"] : []),
          ...Option.match(track, {
            onNone: () => [],
            onSome: (name) => ["--track", "-b", name],
          }),
          "--",
          input.path,
          target,
        ]);
      },
    );

    const removeWorktree = Effect.fn("Git.removeWorktree")(function* (input: {
      readonly repo: string;
      readonly path: string;
      readonly force: boolean;
    }) {
      yield* run(input.repo, [
        "-c",
        "status.showUntrackedFiles=normal",
        "worktree",
        "remove",
        input.path,
        ...(input.force ? ["--force"] : []),
      ]);
    });

    const pruneWorktrees = Effect.fn("Git.pruneWorktrees")(function* (
      repo: string,
    ) {
      yield* run(repo, ["worktree", "prune"]);
    });

    return {
      adminDirOf,
      listWorktrees,
      addWorktree,
      checkoutConfig,
      setWorktreeConfig,
      listRemotes,
      localBranchExists,
      remoteRefExists,
      resolveCheckoutRef,
      checkoutWorktree,
      removeWorktree,
      pruneWorktrees,
    };
  });

export type WorktreeVerbsArea = Effect.Success<
  ReturnType<typeof makeWorktreeVerbs>
>;
