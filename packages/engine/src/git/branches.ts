// Git's branches and remotes: local branches, upstreams and the configured remotes.
import { MIRROR_IGNORES_LIMIT } from "@shigomori/contracts/mirrorIgnores";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  anchorRule,
  escapeGitignorePattern,
  ignoreRulesOf,
  parseBranchRefs,
  pickDefaultRef,
  shortRefName,
  splitZ,
} from "../gitParse.ts";
import { isNotFound } from "../platformErrors.ts";
import {
  BranchNotMergedError,
  GitCommandError,
  stderrOf,
} from "./documents.ts";
import type { RunningArea } from "./running.ts";
import type { WorktreeVerbsArea } from "./worktreeVerbs.ts";

export const makeBranches = ({
  running,
  worktreeVerbs,
}: {
  readonly running: RunningArea;
  readonly worktreeVerbs: WorktreeVerbsArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run, gitPath } = running;
    const {
      listRemotes,
      localBranchExists,
      remoteRefExists,
      resolveCheckoutRef,
    } = worktreeVerbs;
    const branchRefs = Effect.fn("Git.branchRefs")(function* (repo: string) {
      return parseBranchRefs(
        yield* run(repo, [
          "for-each-ref",
          "--format=%(refname) %(symref)",
          "refs/heads",
          "refs/remotes",
        ]),
      );
    });

    // The branches and the default ref picked among them, or none when
    // they can't be read.
    const pickDefault = (
      repo: string,
      override: string | undefined,
      remotes: readonly string[] | undefined,
    ) =>
      Effect.gen(function* () {
        const refs = yield* Effect.option(branchRefs(repo));
        if (Option.isNone(refs)) return Option.none();
        const picked = pickDefaultRef(
          refs.value,
          override,
          remotes ?? (yield* listRemotes(repo)),
        );
        return Option.some({ refs: refs.value, picked });
      });

    const appendExcludes = Effect.fn("Git.appendExcludes")(
      function* (repo: string, paths: ReadonlyArray<string>) {
        if (paths.length === 0) return;
        const excludeFile = yield* gitPath(repo, "info/exclude");
        // Only a file that isn't there yet reads as empty: rewriting one
        // that couldn't be read would lose the user's lines.
        const existing = yield* fs
          .readFileString(excludeFile)
          .pipe(Effect.catchIf(isNotFound, () => Effect.succeed("")));
        const lines = new Set(existing.split("\n"));
        const added = paths
          .map((entry) => `/${escapeGitignorePattern(entry)}`)
          .filter((line) => !lines.has(line));
        if (added.length === 0) return;
        const leading = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
        // Through a temporary file, since the file is the user's.
        const temporary = `${excludeFile}.shigomori-tmp`;
        yield* fs.makeDirectory(path.dirname(excludeFile), { recursive: true });
        yield* fs.writeFileString(
          temporary,
          `${existing}${leading}${added.join("\n")}\n`,
        );
        yield* fs.rename(temporary, excludeFile);
      },
      (effect) => Effect.ignore(effect),
    );

    const resolvePrimaryRef = Effect.fn("Git.resolvePrimaryRef")(function* (
      repo: string,
      override?: string,
      remotes?: readonly string[],
    ) {
      return Option.flatMap(
        yield* pickDefault(repo, override, remotes),
        ({ refs, picked }) =>
          picked === undefined
            ? Option.map(
                Option.fromUndefinedOr(refs.locals[0]),
                (branch) => `refs/heads/${branch}`,
              )
            : Option.some(picked),
      );
    });

    const resolveDefaultBranch = Effect.fn("Git.resolveDefaultBranch")(
      function* (repo: string, override?: string, remotes?: readonly string[]) {
        return Option.map(
          yield* resolvePrimaryRef(repo, override, remotes),
          shortRefName,
        );
      },
    );

    const resolveDefaultRef = Effect.fn("Git.resolveDefaultRef")(function* (
      repo: string,
      override?: string,
    ) {
      return Option.flatMap(
        yield* pickDefault(repo, override, undefined),
        ({ picked }) => Option.fromUndefinedOr(picked),
      );
    });

    const checkoutBranch = Effect.fn("Git.checkoutBranch")(function* (
      worktree: string,
      branch: string,
      remotes?: readonly string[],
    ) {
      // `git checkout origin/main` would detach HEAD, so a remote ref
      // whose local branch is missing makes it, tracking the qualified
      // ref (unambiguous when several remotes share the name). The
      // trailing `--` keeps the name out of the pathspec slot.
      const { target, track } = yield* resolveCheckoutRef(
        worktree,
        branch,
        remotes,
      );
      yield* run(worktree, [
        "checkout",
        ...(Option.isSome(track) ? ["--track"] : []),
        "--end-of-options",
        target,
        "--",
      ]);
    });

    const createBranch = Effect.fn("Git.createBranch")(function* (input: {
      readonly repo: string;
      readonly name: string;
      readonly base?: string | undefined;
    }) {
      // Tracking set explicitly, so it doesn't hang on the user's
      // branch.autoSetupMerge: a branch tracks the remote branch of its
      // own name (origin/foo for foo), and is otherwise unpublished. A
      // local base (even feature/foo) must not track, which would pin
      // the upstream to a local ref.
      const track =
        input.base !== undefined &&
        input.base.endsWith(`/${input.name}`) &&
        !(yield* localBranchExists(input.repo, input.base)) &&
        (yield* remoteRefExists(input.repo, input.base));
      yield* run(input.repo, [
        "branch",
        track ? "--track" : "--no-track",
        "--",
        input.name,
        ...(input.base ? [input.base] : []),
      ]);
    });

    const deleteBranch = Effect.fn("Git.deleteBranch")(function* (input: {
      readonly repo: string;
      readonly name: string;
      readonly force: boolean;
    }) {
      yield* run(input.repo, [
        "branch",
        input.force ? "-D" : "-d",
        "--",
        input.name,
      ]).pipe(
        Effect.catchTags({
          GitCommandError: (
            error,
          ): Effect.Effect<never, GitCommandError | BranchNotMergedError> =>
            !input.force && /not fully merged/.test(stderrOf(error))
              ? Effect.fail(new BranchNotMergedError({ branch: input.name }))
              : Effect.fail(error),
        }),
      );
    });

    // `--directory` collapses a fully ignored directory into one
    // trailing-slash entry. -z keeps non-ASCII names raw, so they compare
    // equal to paths read off the disk.
    const listOthersIgnored = (repo: string, exclude: string) =>
      run(repo, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        exclude,
        "--directory",
      ]).pipe(Effect.map(splitZ));

    const listIgnoreRules = Effect.fn("Git.listIgnoreRules")(function* (
      worktree: string,
    ) {
      // Every .gitignore git can see: tracked ones, and untracked ones it
      // doesn't itself ignore. The pathspec's * spans folders.
      const files = yield* run(worktree, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ".gitignore",
        "*/.gitignore",
      ]).pipe(
        Effect.map(splitZ),
        Effect.orElseSucceed(() => [".gitignore"]),
      );
      const readRules = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.map(ignoreRulesOf),
          Effect.orElseSucceed(() => []),
        );
      const rules: string[] = [];
      for (const file of files.toSorted()) {
        const folder = path.dirname(file) === "." ? "" : path.dirname(file);
        for (const rule of yield* readRules(path.join(worktree, file))) {
          rules.push(anchorRule(rule, folder));
        }
      }
      // The exclude file lives in the repository's git dir, which a
      // linked worktree only points at. Its rules read like the root's.
      const exclude = yield* gitPath(worktree, "info/exclude").pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (exclude !== "") rules.push(...(yield* readRules(exclude)));
      return [...new Set(rules)].slice(0, MIRROR_IGNORES_LIMIT);
    });

    return {
      branchRefs,
      appendExcludes,
      resolveDefaultBranch,
      resolvePrimaryRef,
      resolveDefaultRef,
      checkoutBranch,
      createBranch,
      deleteBranch,
      listOthersIgnored,
      listIgnoreRules,
    };
  });
