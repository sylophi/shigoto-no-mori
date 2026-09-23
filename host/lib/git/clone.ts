import { stat } from "node:fs/promises";
import { join } from "node:path";
import { errorTagOf } from "@shared/errors";
import { isENOENT, pathExists } from "@host/lib/util/paths";
import { GitError, run } from "./core";

// Clones `url` into `parentDir/name` and returns the new checkout's
// path. The payload schema has already held the URL to a real remote
// and the name to one segment. Both checks below are for the message:
// git would refuse either, in words about its own argv.
export async function cloneRepo(
  url: string,
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
  // Nobody is at this process's terminal to answer a credential prompt,
  // least of all when the clone was asked for from another device, so
  // git's own is turned off and a remote it can't authenticate to fails
  // rather than waits. That covers git alone: ssh asking about a host
  // key and an askpass helper prompt on their own, and forcing ssh into
  // batch mode here would override the user's own ssh command. A
  // packaged app has no terminal for ssh to ask on, so it fails there
  // too, and the clone has no timeout beyond that.
  // `--` ends the options: the URL and name come from the caller.
  await run(parentDir, ["clone", "--", url, name], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  }).catch((error: unknown) => {
    // Refusing to prompt, git names the URL it wanted a password for,
    // userinfo and all, and a pasted token sits there. The message goes
    // to a toast and a GitError's output rides the wire as fields, so
    // that part is dropped from both.
    if (error instanceof GitError) {
      throw new GitError({
        stderr: withoutUserinfo(error.stderr),
        stdout: withoutUserinfo(error.stdout),
        exitCode: error.exitCode,
      });
    }
    // A typed error's message is a getter over its fields (a
    // GitOutputTruncated names no URL), so only a plain Error is
    // rewritten.
    if (error instanceof Error && errorTagOf(error) === undefined) {
      error.message = withoutUserinfo(error.message);
    }
    throw error;
  });
  return dest;
}

function withoutUserinfo(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s'"]*@/gi, "$1");
}
