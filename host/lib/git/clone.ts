import { stat } from "node:fs/promises";
import { join } from "node:path";
import { isENOENT, pathExists } from "@host/lib/util/paths";
import { run } from "./core";

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
  // least of all when the clone was asked for from another device, so a
  // remote this machine can't authenticate to fails instead of hanging.
  // `--` ends the options: the URL and name come from the caller.
  await run(parentDir, ["clone", "--", url, name], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  return dest;
}
