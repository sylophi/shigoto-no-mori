import { stat } from "node:fs/promises";
import { join } from "node:path";
import { cloneUrlOf } from "@shared/cloneUrl";
import { ghReady } from "@host/lib/githubCli/readiness";
import { isGithubRemoteUrl } from "@host/lib/githubCli/remote";
import { isENOENT, pathExists } from "@host/lib/util/paths";
import { run } from "./core";

// Where a clone lands: `parentDir/name`, with the parent a folder and
// the destination not yet there. Both checks are for the message: git
// would refuse either, in words about its own argv. The clone from a
// peer (host/lib/sync/cloneFromPeer.ts) and a new repository
// (./init.ts) land the same way.
export async function checkNewCheckoutDestination(
  parentDir: string,
  name: string,
): Promise<string> {
  const parent = await stat(parentDir).catch((error: unknown) => {
    if (isENOENT(error)) return null;
    throw error;
  });
  if (!parent?.isDirectory()) {
    throw new Error(`${parentDir} is not a folder`);
  }
  const dest = join(parentDir, name);
  if (await pathExists(dest)) {
    throw new Error(`${dest} already exists`);
  }
  return dest;
}

// Clones `source` into `parentDir/name` and returns the new checkout's
// path. The payload schema has already held the source to a real remote
// or a GitHub `owner/repo` (cloned over https), and the name to one
// segment.
export async function cloneRepo(
  source: string,
  parentDir: string,
  name: string,
): Promise<string> {
  const dest = await checkNewCheckoutDestination(parentDir, name);
  const url = cloneUrlOf(source);
  // Where the device's gh is signed in, it is git's credential helper
  // for a GitHub remote, the way `gh auth setup-git` would set it up,
  // so a private repository clones over https without that setup. Only
  // for this clone: the URL stays as pasted, and the checkout's config
  // is left alone.
  const ghCredentials =
    (await isGithubRemoteUrl(url)) && (await ghReady())
      ? [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
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
  await run(parentDir, [...ghCredentials, "clone", "--", url, name], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  }).catch((error: unknown) => {
    // Refusing to prompt, git names the URL it wanted a password for,
    // userinfo and all, and a pasted token sits there. The message goes
    // to a toast, so that part is dropped.
    if (error instanceof Error) {
      error.message = error.message.replace(/(https?:\/\/)[^/\s'"]*@/gi, "$1");
    }
    throw error;
  });
  return dest;
}
