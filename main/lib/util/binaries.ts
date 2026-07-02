// `which`-based probe for a CLI on the user's PATH. The main process
// patches PATH from the login shell profile at startup (shellPath.ts),
// so anything installed for the user's terminal is found here too.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function binaryOnPath(name: string): Promise<boolean> {
  try {
    await execFileP("which", [name]);
    return true;
  } catch {
    return false;
  }
}
