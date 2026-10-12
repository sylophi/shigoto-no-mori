// Git's new repositories: where one may land, a clone, and a fresh one.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isNotFound } from "../platformErrors.ts";
import {
  CloneDestinationError,
  GitCommandError,
  redactUserinfo,
  stderrOf,
} from "./documents.ts";
import type { RunningArea } from "./running.ts";

export const makeRepositories = ({
  running,
}: {
  readonly running: RunningArea;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { run } = running;

    // `parentDir/name`, with the parent a folder and the destination
    // not there yet. Both checks are for the message: git would refuse
    // either, in words about its own argv.
    const checkDestination = Effect.fn("Git.checkDestination")(function* (
      parentDir: string,
      name: string,
    ) {
      const parent = yield* fs
        .stat(parentDir)
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
      if (parent?.type !== "Directory") {
        return yield* new CloneDestinationError({
          path: parentDir,
          reason: "not-a-folder",
        });
      }
      const dest = path.join(parentDir, name);
      // A symlink is there even when what it points at isn't.
      const symlink = fs.readLink(dest).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if ((yield* fs.exists(dest)) || (yield* symlink)) {
        return yield* new CloneDestinationError({
          path: dest,
          reason: "exists",
        });
      }
      return dest;
    });

    const clone = Effect.fn("Git.clone")(function* (input: {
      readonly url: string;
      readonly parentDir: string;
      readonly name: string;
      readonly config?: ReadonlyArray<readonly [string, string]> | undefined;
    }) {
      const dest = yield* checkDestination(input.parentDir, input.name);
      // Nobody may be at a terminal to answer a credential prompt (least
      // of all for a clone asked for from another device), so git's own
      // is off and an unauthenticated remote fails rather than waits.
      // `config` is written into the new checkout's config too.
      yield* run(
        input.parentDir,
        [
          "clone",
          ...(input.config ?? []).flatMap(([key, value]) => [
            "-c",
            `${key}=${value}`,
          ]),
          "--",
          input.url,
          input.name,
        ],
        { env: { GIT_TERMINAL_PROMPT: "0" } },
      ).pipe(
        // Refusing to prompt, git names the URL it wanted a password
        // for, userinfo and all, and a pasted token sits there.
        Effect.mapError((error) =>
          error instanceof GitCommandError
            ? new GitCommandError({
                subcommand: error.subcommand,
                exitCode: error.exitCode,
                cause: new Error(redactUserinfo(stderrOf(error))),
              })
            : error,
        ),
      );
      return dest;
    });

    // A repository at `parentDir/name`, with an empty first commit: a
    // worktree branches off the default branch, and an unborn one has
    // nothing to branch off. A failed start leaves nothing behind.
    const createRepository = Effect.fn("Git.createRepository")(function* (
      parentDir: string,
      name: string,
    ) {
      const dest = yield* checkDestination(parentDir, name);
      yield* fs.makeDirectory(dest);
      yield* Effect.gen(function* () {
        // git's own default is still master. Unless the user
        // configured theirs, a new repo starts on main, as one made on
        // GitHub does.
        const configured = (yield* run(dest, [
          "config",
          "--get",
          "init.defaultBranch",
        ]).pipe(
          Effect.catchTags({ GitCommandError: () => Effect.succeed("") }),
        )).trim();
        yield* run(dest, ["init", `--initial-branch=${configured || "main"}`]);
        // No hooks: the user's global ones have nothing to check in an
        // empty commit, and one that rejects it would refuse the repo.
        yield* run(dest, [
          "commit",
          "--allow-empty",
          "--no-verify",
          "-m",
          "Initial commit",
        ]);
      }).pipe(
        Effect.tapError(() =>
          Effect.ignore(fs.remove(dest, { recursive: true })),
        ),
      );
      return dest;
    });

    return { checkDestination, clone, createRepository };
  });

export type RepositoriesArea = Effect.Success<
  ReturnType<typeof makeRepositories>
>;
