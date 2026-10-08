// A worktree's uncommitted state as a commit the sync moves can carry:
// captured on its HEAD under refs/shigomori/dirty/<id>, and applied back
// onto a checkout of the same commit somewhere else.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { messageOf } from "./errorDocument.ts";
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
    names: Schema.Array(Schema.String),
    count: Schema.Int,
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

  override get message(): string {
    const [first = "", second = ""] = this.names;
    switch (this.reason) {
      case "no-capture":
        return "No dirty-state capture for this worktree.";
      case "base-mismatch":
        return `The capture was taken on ${first.slice(0, 12)} but this worktree is on ${second.slice(0, 12)}. Sync the branch first, then apply.`;
      case "uncommitted":
        return `Worktree has ${this.count} uncommitted change(s) that apply would overwrite. Commit them first, or pass --force.`;
      case "unreadable":
        return `Couldn't check for uncommitted changes (${messageOf(this.cause)}). Fix the worktree, or pass --force to apply anyway.`;
      case "overwrite": {
        const more = this.count > 3 ? ` and ${this.count - 3} more` : "";
        return `Applying would overwrite existing file(s) the capture adds: ${this.names.join(", ")}${more}. Move or delete them first.`;
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
    // worktree's ref. A clean worktree drops any capture it had.
    readonly capture: (
      target: DirtyTarget,
    ) => Effect.Effect<Captured, NoHead | Git.GitError>;
    // The capture's changes back onto the worktree, which must be on
    // the commit it was taken on. Untracked files come back untracked.
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

  // The paths that differ between two commits, `filter` narrowing them
  // (--diff-filter=A for the added ones).
  const diffPaths = (
    repo: string,
    from: string,
    to: string,
    filter: ReadonlyArray<string> = [],
  ) =>
    git
      .run(repo, [
        "diff-tree",
        "-r",
        "-z",
        "--name-only",
        ...filter,
        "--no-renames",
        "--end-of-options",
        from,
        to,
      ])
      .pipe(Effect.map(nulFields));

  const capture = Effect.fn("Dirty.capture")(function* (target: DirtyTarget) {
    const { projectPath, worktreePath, worktreeId } = target;
    const parent = (yield* git
      .run(worktreePath, ["rev-parse", "HEAD"])
      .pipe(Effect.mapError((cause) => new NoHead({ cause })))).trim();
    // A scratch index, so the worktree's own staging stays as it is.
    const tree = yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs
          .makeTempDirectoryScoped({ prefix: "sm-dirty-" })
          .pipe(Effect.orDie);
        const options = {
          env: { GIT_INDEX_FILE: path.join(dir, "index") },
        };
        yield* git.run(
          worktreePath,
          ["read-tree", "--end-of-options", parent],
          options,
        );
        yield* git.run(worktreePath, ["add", "-A"], options);
        return (yield* git.run(worktreePath, ["write-tree"], options)).trim();
      }),
    );
    const headTree = (yield* git.run(worktreePath, [
      "rev-parse",
      "HEAD^{tree}",
    ])).trim();
    if (tree === headTree) {
      yield* git.deleteRef(projectPath, dirtyRef(worktreeId));
      return { captured: false } as const;
    }
    const commit = (yield* git.run(worktreePath, [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      `shigomori dirty state ${worktreeId}`,
    ])).trim();
    yield* git.run(projectPath, [
      "update-ref",
      "--end-of-options",
      dirtyRef(worktreeId),
      commit,
    ]);
    const changed = yield* diffPaths(projectPath, parent, commit);
    return {
      captured: true,
      commit,
      parent,
      changedFiles: changed.length,
    } as const;
  });

  const refuse = (
    reason: ApplyRefused["reason"],
    fields: {
      readonly names?: ReadonlyArray<string>;
      readonly count?: number;
      readonly cause?: unknown;
    } = {},
  ) =>
    new ApplyRefused({
      reason,
      names: [...(fields.names ?? [])],
      count: fields.count ?? 0,
      ...(fields.cause === undefined ? {} : { cause: fields.cause }),
    });

  // A file or a link at `file`, a dangling one included.
  const present = (file: string) =>
    fs.exists(file).pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.succeed(true) : fs.readLink(file).pipe(Effect.as(true)),
      ),
      Effect.orElseSucceed(() => false),
    );

  const apply = Effect.fn("Dirty.apply")(function* (
    target: DirtyTarget,
    options: { readonly force: boolean },
  ) {
    const { projectPath, worktreePath, worktreeId } = target;
    const found = yield* git.refTip(projectPath, dirtyRef(worktreeId));
    if (Option.isNone(found)) return yield* refuse("no-capture");
    const commit = found.value;
    const parent = (yield* git.run(projectPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${commit}^`,
    ])).trim();
    const head = (yield* git.run(worktreePath, ["rev-parse", "HEAD"])).trim();
    if (head !== parent) {
      return yield* refuse("base-mismatch", { names: [parent, head] });
    }
    if (!options.force) {
      const status = yield* git
        .status(worktreePath, "normal")
        .pipe(Effect.result);
      if (Result.isFailure(status)) {
        return yield* refuse("unreadable", { cause: status.failure });
      }
      if (status.success.length > 0) {
        return yield* refuse("uncommitted", {
          count: status.success.length,
        });
      }
    }
    // The files the capture adds must not be there already: read-tree
    // would overwrite them.
    const added = yield* diffPaths(projectPath, parent, commit, [
      "--diff-filter=A",
    ]);
    const colliding = yield* Effect.filter(added, (relative) =>
      present(path.join(worktreePath, relative)),
    );
    if (colliding.length > 0) {
      return yield* refuse("overwrite", {
        names: colliding.slice(0, 3),
        count: colliding.length,
      });
    }
    const changed = yield* diffPaths(projectPath, parent, commit);
    yield* git
      .run(worktreePath, [
        "read-tree",
        "-m",
        "-u",
        "--end-of-options",
        parent,
        commit,
      ])
      .pipe(Effect.mapError((cause) => refuse("overlap", { cause })));
    // The changes stay in the files, not in the index.
    yield* git.run(worktreePath, ["reset", "-q"]);
    yield* git.deleteRef(projectPath, dirtyRef(worktreeId)).pipe(Effect.ignore);
    return { commit, changedFiles: changed.length };
  });

  return Dirty.of({ capture, apply });
});

export const layer = Layer.effect(Dirty, make);
