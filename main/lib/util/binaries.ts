// PATH probe for a CLI (`which` on POSIX, `where` on Windows). The main
// process patches PATH from the login shell profile at startup on macOS
// (shellPath.ts), so anything installed for the user's terminal is found
// here too. Windows GUI apps inherit the full user PATH already.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isWindows } from "./platform";

const execFileP = promisify(execFile);

const PROBE = isWindows ? "where" : "which";

export async function binaryOnPath(name: string): Promise<boolean> {
  try {
    // windowsHide: a console-subsystem child spawned from a windowless
    // GUI parent would otherwise flash a console window per probe.
    await execFileP(PROBE, [name], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
