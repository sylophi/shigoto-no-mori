import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { isENOENT, pathExists } from "@host/lib/util/paths";
import { GitError, runEffect, runGit } from "./core";

// Clones `url` into `parentDir/name` and returns the new checkout's
// path. The payload schema has already held the URL to a real remote
// and the name to one segment. Both checks below are for the message:
// git would refuse either, in words about its own argv.
export const cloneRepoEffect = Effect.fn("clone.cloneRepo")(function* (
  url: string,
  parentDir: string,
  name: string,
) {
  const parent = yield* Effect.tryPromise({
    try: () =>
      stat(parentDir).catch((error: unknown) => {
        if (isENOENT(error)) return null;
        throw error;
      }),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
  if (!parent?.isDirectory()) {
    return yield* Effect.fail(new Error(`${parentDir} is not a folder`));
  }
  const dest = join(parentDir, name);
  if (yield* Effect.promise(() => pathExists(dest))) {
    return yield* Effect.fail(new Error(`${dest} already exists`));
  }
  // Nobody is at this process's terminal to answer a credential prompt,
  // least of all when the clone was asked for from another device, so
  // git's own is turned off and a remote it can't authenticate to fails
  // rather than waits. That covers git alone: ssh asking about a host
  // key and an askpass helper prompt on their own, and forcing ssh into
  // batch mode here would override the user's own ssh command. A
  // packaged app has no terminal for ssh to ask on, so it fails there
  // too, and the clone has no timeout beyond the runner's own bound.
  // `--` ends the options: the URL and name come from the caller.
  yield* runEffect(parentDir, ["clone", "--", url, name], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  }).pipe(
    // Refusing to prompt, git names the URL it wanted a password for,
    // userinfo and all, and a pasted token sits there. The message goes
    // to a toast and a GitError's output rides the wire as fields, so
    // that part is dropped from both. The other failures' messages are
    // built from fields that name no URL.
    Effect.mapError((error) =>
      error instanceof GitError
        ? new GitError({
            stderr: withoutUserinfo(error.stderr),
            stdout: withoutUserinfo(error.stdout),
            exitCode: error.exitCode,
          })
        : error,
    ),
  );
  return dest;
});

export function cloneRepo(
  url: string,
  parentDir: string,
  name: string,
): Promise<string> {
  return runGit(cloneRepoEffect(url, parentDir, name));
}

function withoutUserinfo(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s'"]*@/gi, "$1");
}
