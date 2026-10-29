// Git's new repositories: where one may land, a clone, and a fresh one.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { CloneProgress } from "@shigomori/contracts/modules/projects";
import { isNotFound } from "../platformErrors.ts";
import {
  CloneDestinationError,
  GitCommandError,
  redactUserinfo,
  stderrOf,
} from "./documents.ts";
import type { RunningArea } from "./running.ts";

// One of the progress lines git writes with --progress, as "Receiving
// objects:  45% (556/1234), 12.34 MiB | 5.00 MiB/s": the step, its
// percent, and while it downloads, the size so far in git's units. A
// line from the remote's side is that side packing.
const PROGRESS_LINE =
  /^(remote: )?([A-Za-z ]+):\s+(\d+)% \(\d+\/\d+\)(?:, ([\d.]+) (bytes|KiB|MiB|GiB))?/;
const PROGRESS_STEPS = new Map<string, CloneProgress["step"]>([
  ["Receiving objects", "receiving"],
  ["Resolving deltas", "resolving"],
  ["Updating files", "checkout"],
]);
const UNIT_BYTES: Record<string, number> = {
  bytes: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

const cloneProgressOf = (line: string): CloneProgress | undefined => {
  const match = PROGRESS_LINE.exec(line);
  if (match === null) return undefined;
  const [, remote, title = "", percent, size, unit = ""] = match;
  const step = remote === undefined ? PROGRESS_STEPS.get(title) : "remote";
  if (step === undefined) return undefined;
  return {
    step,
    percent: Number(percent),
    ...(size === undefined
      ? {}
      : { bytes: Math.round(Number(size) * (UNIT_BYTES[unit] ?? 1)) }),
  };
};

// Git's stderr as it comes, to each step and percent it reaches: the
// last whole line of a read is where it is now.
const progressReader = (
  onProgress: (progress: CloneProgress) => Effect.Effect<void>,
) => {
  const decoder = new TextDecoder();
  let partial = "";
  return (chunk: Uint8Array) =>
    Effect.suspend(() => {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split(
        /[\r\n]/,
      );
      partial = lines.pop() ?? "";
      const progress = lines.map(cloneProgressOf).findLast(Boolean);
      return progress === undefined ? Effect.void : onProgress(progress);
    });
};

// What git said about a failed clone without the progress it wrote on
// the way: a line per step, redrawn after each \r.
const PROGRESS_SEGMENT = /^(remote: )?[A-Za-z ]+:\s+(\d+% \(|\d+, done\.)/;
const withoutProgress = (stderr: string) =>
  stderr
    .split(/[\r\n]/)
    .filter((line) => line.trim() !== "" && !PROGRESS_SEGMENT.test(line))
    .join("\n");

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
      readonly onProgress?:
        | ((progress: CloneProgress) => Effect.Effect<void>)
        | undefined;
    }) {
      const dest = yield* checkDestination(input.parentDir, input.name);
      const { onProgress } = input;
      // Nobody may be at a terminal to answer a credential prompt (least
      // of all for a clone asked for from another device), so git's own
      // is off and an unauthenticated remote fails rather than waits.
      // `config` is written into the new checkout's config too.
      // Interrupted (a caller's cancel), the runner ends git and waits
      // for it, and git removes the folder it made on its way out.
      yield* run(
        input.parentDir,
        [
          "clone",
          ...(input.config ?? []).flatMap(([key, value]) => [
            "-c",
            `${key}=${value}`,
          ]),
          // Off by default when stderr is no terminal, and it is a file.
          ...(onProgress === undefined ? [] : ["--progress"]),
          "--",
          input.url,
          input.name,
        ],
        {
          env: { GIT_TERMINAL_PROMPT: "0" },
          onStderr: onProgress && progressReader(onProgress),
        },
      ).pipe(
        // Refusing to prompt, git names the URL it wanted a password
        // for, userinfo and all, and a pasted token sits there.
        Effect.mapError((error) =>
          error instanceof GitCommandError
            ? new GitCommandError({
                subcommand: error.subcommand,
                exitCode: error.exitCode,
                cause: new Error(
                  redactUserinfo(withoutProgress(stderrOf(error))),
                ),
              })
            : error,
        ),
      );
      return dest;
    });

    // A repository at `parentDir/name`, with an empty first commit: a
    // worktree branches off the default branch, and an unborn one has
    // nothing to branch off. A start that fails or is interrupted (the
    // add-project dialog's Cancel) leaves nothing behind.
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
        Effect.onError(() =>
          Effect.ignore(fs.remove(dest, { recursive: true })),
        ),
      );
      return dest;
    });

    return { checkDestination, clone, createRepository };
  });
