// PATH probe for a CLI. The main process patches PATH from the login
// shell profile at startup (shellPath.ts), so anything installed for the
// user's terminal is found here too.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// The resolved absolute path of a CLI on PATH, or null when absent.
export async function resolveOnPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("which", [name]);
    const found = stdout.trim();
    return found === "" ? null : found;
  } catch {
    return null;
  }
}

export async function binaryOnPath(name: string): Promise<boolean> {
  return (await resolveOnPath(name)) !== null;
}
