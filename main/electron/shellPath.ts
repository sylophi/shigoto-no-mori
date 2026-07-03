// macOS GUI apps launch via launchd with a minimal PATH that doesn't include
// the additions users keep in .zshrc / .bash_profile / Homebrew shellenv.
// Capture the user's actual interactive PATH once at startup so every child
// process we spawn afterwards (script runner, launchers, git) can find the
// tools they expect.
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const SENTINEL = "__SHIGOMORI_PATH__";

export async function applyUserShellPath(): Promise<void> {
  // Windows GUI apps inherit the user's full PATH from the registry-backed
  // environment; there is no login-shell profile to source, so this whole
  // capture is a POSIX-only concern.
  if (process.platform === "win32") return;
  const shell = process.env["SHELL"] ?? userInfo().shell ?? null;
  if (!shell) return;
  try {
    // -i sources the interactive init file (.zshrc / .bashrc) where most
    // users put their PATH additions; -l also sources login files
    // (.zprofile, .bash_profile). Sentinel-wrap the value so any banner
    // .zshrc prints before our printf can be sliced off.
    const { stdout } = await execFileP(
      shell,
      ["-ilc", `printf '%s%s' '${SENTINEL}' "$PATH"`],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const idx = stdout.lastIndexOf(SENTINEL);
    if (idx < 0) return;
    const captured = stdout.slice(idx + SENTINEL.length).trim();
    if (captured && captured !== process.env["PATH"]) {
      process.env["PATH"] = captured;
      console.log(`[shell] patched PATH from ${shell}`);
    }
  } catch (err) {
    console.warn(`[shell] failed to capture PATH from ${shell}:`, err);
  }
}
