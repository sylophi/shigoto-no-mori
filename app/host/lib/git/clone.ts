import { stat } from "node:fs/promises";
import { join } from "node:path";
import { cloneUrlOf } from "@shigomori/contracts/predicates/remoteUrl";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import { isENOENT, pathExists } from "@host/lib/util/paths";
import { GitError, run } from "./core";

// A place a checkout cannot land.
class DestinationError extends Schema.TaggedError<DestinationError>()(
  "DestinationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// Where a clone lands: `parentDir/name`, with the parent a folder and
// the destination not yet there. Both checks are for the message: git
// would refuse either, in words about its own argv. The clone from a
// peer (host/lib/sync/cloneFromPeer.ts) and a new repository
// (./init.ts) land the same way.
export const checkNewCheckoutDestination = Effect.fnUntraced(function* (
  parentDir: string,
  name: string,
) {
  const parent = yield* Effect.promise(() =>
    stat(parentDir).catch((error: unknown) => {
      if (isENOENT(error)) return null;
      throw error;
    }),
  );
  if (!parent?.isDirectory()) {
    return yield* new DestinationError({
      reason: `${parentDir} is not a folder`,
    });
  }
  const dest = join(parentDir, name);
  if (yield* Effect.promise(() => pathExists(dest))) {
    return yield* new DestinationError({ reason: `${dest} already exists` });
  }
  return dest;
});

// Clones `source` into `parentDir/name` and returns the new checkout's
// path. The payload schema has already held the source to a real remote
// or a GitHub `owner/repo` (cloned over https), and the name to one
// segment.
export const cloneRepo = Effect.fn("clone")(function* (
  source: string,
  parentDir: string,
  name: string,
) {
  const dest = yield* checkNewCheckoutDestination(parentDir, name);
  const url = cloneUrlOf(source);
  // Over https to a GitHub host, with the device's gh signed in, gh is
  // git's credential helper, so a private repository clones without
  // `gh auth setup-git` having been run. `clone -c` writes the helper
  // into the new checkout's config too, scoped to that host the way
  // setup-git scopes it, so the app's later fetches and pushes sign in
  // the same way. The URL stays as given.
  const cli = yield* GithubCli;
  const host = /^https:\/\//i.test(url) ? yield* cli.hostOf(url) : null;
  const ghCredentials =
    host !== null && (yield* cli.unavailableReason) === null
      ? [
          "-c",
          `credential.https://${host}.helper=`,
          "-c",
          `credential.https://${host}.helper=!gh auth git-credential`,
        ]
      : [];
  // Nobody is at this process's terminal to answer a credential prompt,
  // least of all when the clone was asked for from another device, so
  // git's own is turned off and a remote it can't authenticate to fails
  // rather than waits. That covers git alone: ssh asking about a host
  // key and an askpass helper prompt on their own, and forcing ssh into
  // batch mode here would override the user's own ssh command. A
  // packaged app has no terminal for ssh to ask on, so it fails there
  // too, and the clone has no timeout beyond that.
  // `--` ends the options: the URL and name come from the caller.
  yield* run(parentDir, ["clone", ...ghCredentials, "--", url, name], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  }).pipe(
    // Refusing to prompt, git names the URL it wanted a password for,
    // userinfo and all, and a pasted token sits there. The message goes
    // to a toast, so that part is dropped.
    Effect.mapError(
      (error) =>
        new GitError({
          ...error,
          reason: error.reason.replace(/(https?:\/\/)[^/\s'"]*@/gi, "$1"),
        }),
    ),
  );
  return dest;
});
