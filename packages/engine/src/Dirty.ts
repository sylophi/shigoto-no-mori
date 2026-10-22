// A worktree's uncommitted state as a commit the sync moves can carry:
// captured on its HEAD under refs/shigomori/dirty/<id>, and applied back
// onto a checkout of the same commit somewhere else.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { errnoText, isNotFound } from "./platformErrors.ts";
import { messageOf } from "./errorDocument.ts";
import { entryExists } from "./entries.ts";
import * as Git from "./Git.ts";

export const dirtyRef = (worktreeId: string) =>
  `refs/shigomori/dirty/${worktreeId}`;

// What capture and apply act on: the worktree, and the repository whose
// refs hold the capture.
export type DirtyTarget = {
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly worktreeId: string;
};

export type Captured =
  | { readonly captured: false }
  | {
      readonly captured: true;
      readonly commit: string;
      readonly parent: string;
      readonly changedFiles: number;
    };

export type Applied = {
  readonly commit: string;
  readonly changedFiles: number;
};

// The worktree's HEAD didn't resolve, so there is nothing to capture on.
export class NoHead extends Schema.TaggedError<NoHead>()("NoHead", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Couldn't resolve the worktree's HEAD (${messageOf(this.cause)}).`;
  }
}

// The capture's scratch space couldn't be made: a full disk, or a
// temporary folder the process may not write.
export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()(
  "CaptureFailed",
  { reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't capture the worktree's uncommitted changes: ${this.reason}.`;
  }
}

// Why a capture won't go onto the worktree.
export class ApplyRefused extends Schema.TaggedError<ApplyRefused>()(
  "ApplyRefused",
  {
    reason: Schema.Literals([
      "no-capture",
      "base-mismatch",
      "uncommitted",
      "unreadable",
      "overwrite",
      "overlap",
    ]),
    // The commits a mismatch names, the files an overwrite names, the
    // count of uncommitted changes.
    names: Schema.optional(Schema.Array(Schema.String)),
    count: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get documentCode(): string | undefined {
    switch (this.reason) {
      case "no-capture":
        return "no-capture";
      case "base-mismatch":
        return "capture-base-mismatch";
      case "overwrite":
        return "capture-overwrite";
      default:
        return undefined;
    }
  }

  get flagHint(): string | undefined {
    return this.reason === "uncommitted" || this.reason === "unreadable"
      ? "Pass --force to apply anyway."
      : undefined;
  }

  override get message(): string {
    const names = this.names ?? [];
    const count = this.count ?? 0;
    const [first = "", second = ""] = names;
    switch (this.reason) {
      case "no-capture":
        return "No dirty-state capture for this worktree.";
      case "base-mismatch":
        return `The capture was taken on ${first.slice(0, 12)} but this worktree is on ${second.slice(0, 12)}. Sync the branch first, then apply.`;
      case "uncommitted":
        return `Worktree has ${count} uncommitted change(s) that apply would overwrite. Commit them first.`;
      case "unreadable":
        return `Couldn't check for uncommitted changes (${messageOf(this.cause)}). Fix the worktree first.`;
      case "overwrite": {
        const more = count > 3 ? ` and ${count - 3} more` : "";
        return `Applying would overwrite existing file(s) the capture adds: ${names.join(", ")}${more}. Move or delete them first.`;
      }
      case "overlap":
        return `The worktree's local changes overlap the capture, so git refused to apply it. Commit or discard them first. (${messageOf(this.cause)})`;
    }
  }
}

export class Dirty extends Context.Service<
  Dirty,
  {
    // Commits every change, untracked files included, onto HEAD without
    // touching the index or the files, and keeps it under the
    // worktree's ref, with what is staged. A clean worktree drops any
    // capture it had.
    readonly capture: (
      target: DirtyTarget,
    ) => Effect.Effect<Captured, NoHead | CaptureFailed | Git.GitError>;
    // The capture's changes back onto the worktree, which must be on
    // the commit it was taken on, staged and unstaged as they were.
    // Untracked files come back untracked.
    readonly apply: (
      target: DirtyTarget,
      options: { readonly force: boolean },
    ) => Effect.Effect<Applied, ApplyRefused | Git.GitError>;
  }
>()("sm/engine/Dirty") {}

const nulFields = (stdout: string) =>
  stdout.split("\0").filter((field) => field !== "");

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // What changed between two commits, each path with its status letter.
  const changes = (repo: string, from: string, to: string) =>
    git
      .run(repo, [
        "diff-tree",
        "-r",
        "-z",
        "--name-status",
        "--no-renames",
        "--end-of-options",
        from,
        to,
      ])
      .pipe(
        Effect.map((stdout) => {
          const fields = nulFields(stdout);
          const found: Array<{ status: string; path: string }> = [];
          for (let index = 0; index + 1 < fields.length; index += 2) {
            found.push({
              status: fields[index] ?? "",
              path: fields[index + 1] ?? "",
            });
          }
          return found;
        }),
      );

  // Made by sm, so it needs no identity of the user's.
  const IDENTITY = {
    GIT_AUTHOR_NAME: "Shigoto no Mori",
    GIT_AUTHOR_EMAIL: "shigomori@localhost",
    GIT_COMMITTER_NAME: "Shigoto no Mori",
    GIT_COMMITTER_EMAIL: "shigomori@localhost",
  };

  const capture = Effect.fn("Dirty.capture")(function* (target: DirtyTarget) {
    const { projectPath, worktreePath, worktreeId } = target;
    const parent = (yield* git
      .run(worktreePath, ["rev-parse", "HEAD"])
      .pipe(Effect.mapError((cause) => new NoHead({ cause })))).trim();
    // A scratch copy of the index, so the worktree's own staging stays as
    // it is: what is staged is its tree, and `add -A` then adds the rest.
    const { tree, staged } = yield* Effect.scoped(
      Effect.gen(function* () {
        const failed = (cause: PlatformError.PlatformError) =>
          new CaptureFailed({ reason: errnoText(cause), cause });
        const dir = yield* fs
          .makeTempDirectoryScoped({ prefix: "sm-dirty-" })
          .pipe(Effect.mapError(failed));
        const scratch = path.join(dir, "index");
        const options = { env: { GIT_INDEX_FILE: scratch } };
        const copied = yield* fs
          .copyFile(yield* git.gitPath(worktreePath, "index"), scratch)
          .pipe(
            Effect.as(true),
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
            Effect.mapError(failed),
          );
        // A worktree git hasn't touched yet has no index: HEAD's tree.
        if (!copied) {
          yield* git.run(
            worktreePath,
            ["read-tree", "--end-of-options", parent],
            options,
          );
        }
        // An index holding a conflict has no tree, and nothing staged
        // moves then.
        const index = yield* git
          .run(worktreePath, ["write-tree"], options)
          .pipe(Effect.option);
        // The copy's assume-unchanged marks would hide edits from
        // `add -A`: a really-refresh clears them where the file changed.
        // A conflict's entries are left for `add -A` to resolve.
        yield* git.run(
          worktreePath,
          ["update-index", "-q", "--unmerged", "--really-refresh"],
          options,
        );
        yield* git.run(worktreePath, ["add", "-A"], options);
        return {
          tree: (yield* git.run(worktreePath, ["write-tree"], options)).trim(),
          staged: Option.map(index, (out) => out.trim()),
        };
      }),
    );
    // Against the commit the tree was built on, which HEAD may have left.
    const parentTree = yield* git.treeOf(worktreePath, parent);
    const index = Option.filter(staged, (written) => written !== parentTree);
    if (tree === parentTree && Option.isNone(index)) {
      yield* git.deleteRef(projectPath, dirtyRef(worktreeId));
      return { captured: false } as const;
    }
    const commitTree = (of: string, parents: readonly string[]) =>
      git
        .run(
          worktreePath,
          [
            "commit-tree",
            of,
            ...parents.flatMap((commit) => ["-p", commit]),
            "-m",
            `shigomori dirty state ${worktreeId}`,
          ],
          { env: IDENTITY },
        )
        .pipe(Effect.map((out) => out.trim()));
    // What was staged rides as the second parent, as in git stash.
    const commit = yield* commitTree(tree, [
      parent,
      ...(Option.isSome(index)
        ? [yield* commitTree(index.value, [parent])]
        : []),
    ]);
    yield* git.updateRef({
      repo: projectPath,
      ref: dirtyRef(worktreeId),
      commit,
    });
    const changed = yield* changes(projectPath, parent, commit);
    return {
      captured: true,
      commit,
      parent,
      changedFiles: changed.length,
    } as const;
  });

  const apply = Effect.fn("Dirty.apply")(function* (
    target: DirtyTarget,
    options: { readonly force: boolean },
  ) {
    const { projectPath, worktreePath, worktreeId } = target;
    const found = yield* git.refTip(projectPath, dirtyRef(worktreeId));
    if (Option.isNone(found)) {
      return yield* new ApplyRefused({ reason: "no-capture" });
    }
    const commit = found.value;
    const parent = yield* git.verifyRev(projectPath, `${commit}^`);
    const head = (yield* git.run(worktreePath, ["rev-parse", "HEAD"])).trim();
    if (head !== parent) {
      return yield* new ApplyRefused({
        reason: "base-mismatch",
        names: [parent, head],
      });
    }
    if (!options.force) {
      const changed = yield* git.changedCount(worktreePath).pipe(Effect.result);
      if (Result.isFailure(changed)) {
        return yield* new ApplyRefused({
          reason: "unreadable",
          cause: changed.failure,
        });
      }
      if (changed.success > 0) {
        return yield* new ApplyRefused({
          reason: "uncommitted",
          count: changed.success,
        });
      }
    }
    // The files the capture adds must not be there already: read-tree
    // would overwrite them.
    const changed = yield* changes(projectPath, parent, commit);
    const colliding = yield* Effect.filter(
      changed.filter(({ status }) => status === "A"),
      ({ path: relative }) =>
        entryExists(fs, path.join(worktreePath, relative)),
    );
    if (colliding.length > 0) {
      return yield* new ApplyRefused({
        reason: "overwrite",
        names: colliding.slice(0, 3).map(({ path: relative }) => relative),
        count: colliding.length,
      });
    }
    yield* git.withIndexLock(
      worktreePath,
      git.refreshIndex(worktreePath).pipe(
        Effect.andThen(
          git.run(worktreePath, [
            "read-tree",
            "-m",
            "-u",
            "--end-of-options",
            parent,
            commit,
          ]),
        ),
        Effect.mapError(
          (cause) => new ApplyRefused({ reason: "overlap", cause }),
        ),
      ),
    );
    // The index as it was captured: what was staged, else HEAD's.
    const staged = yield* git.refTip(projectPath, `${commit}^2`);
    yield* git.run(
      worktreePath,
      Option.isSome(staged)
        ? ["read-tree", "-m", "-i", "--end-of-options", staged.value]
        : ["reset", "-q"],
    );
    yield* git.deleteRef(projectPath, dirtyRef(worktreeId)).pipe(Effect.ignore);
    return { commit, changedFiles: changed.length };
  });

  return Dirty.of({ capture, apply });
});

export const layer = Layer.effect(Dirty, make);
