// Launch-time install of the sgm CLI as a symlink into a PATH bin dir,
// pointing at the binary bundled in the app's Resources -- the VS Code
// / Docker Desktop pattern. No copy means no version drift: the app
// updater swaps the bundle and the link stays current. The first offer
// is a prompt (Install / Not Now / Don't Ask Again); after that, a
// link we own is silently repaired if the app moved.
//
// Naming and path policy lives in @shared/sgmDist.mts; this module
// only owns the prompt flow and the "is that link ours?" judgment.
//
// macOS-only for now: the Windows portable zip has no stable install
// location to link from, so Windows keeps the app-only workflow.
import { lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  replaceWithSymlinkSync,
  sgmBinaryName,
  sgmUserBinDir,
} from "@shared/sgmDist.mts";
import { app, dialog } from "electron";
import { readGlobalConfig, writeGlobalConfig } from "../lib/config/global";
import { comparablePath, pathExists } from "../lib/util/paths";
import { isWindows } from "../lib/util/platform";

const BINARY = sgmBinaryName("prod");

function bundledPath(): string {
  return join(process.resourcesPath, BINARY);
}

// ~-abbreviated form for dialog text.
function displayDir(dir: string): string {
  const home = homedir();
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

function linkPath(): string {
  return join(sgmUserBinDir(), BINARY);
}

// A link target is "ours" when it points at an sgm inside some app
// bundle's Resources -- including a previous install from an old app
// location or a renamed bundle. Anything else at the link path was put
// there by the user (their own build, another tool) and is never
// touched.
function isOurTarget(target: string): boolean {
  return target.endsWith(`/Contents/Resources/${BINARY}`);
}

function isOnPath(dir: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((entry) => comparablePath(entry) === comparablePath(dir));
}

// Call after applyUserShellPath so the PATH check sees the login
// shell's PATH, not launchd's stripped one. Never blocks startup;
// failures only log.
export async function maybeInstallSgmCli(): Promise<void> {
  // Dev builds carry no bundled binary to link against.
  if (!app.isPackaged || isWindows) return;
  if (!(await pathExists(bundledPath()))) return;
  // Gatekeeper app translocation (quarantined app run from ~/Downloads)
  // mounts the bundle at a randomized read-only path that dies with the
  // process -- a link to it would dangle immediately. The prompt will
  // fire on a later launch once the app lives somewhere real.
  if (process.resourcesPath.includes("/AppTranslocation/")) return;

  const existing = await lstat(linkPath()).catch(() => null);
  if (existing !== null) {
    if (!existing.isSymbolicLink()) return; // user's own binary; hands off
    const target = await readlink(linkPath()).catch(() => null);
    if (target === null) return;
    if (comparablePath(target) === comparablePath(bundledPath())) return;
    if (isOurTarget(target)) {
      // Our link, stale target (app moved or was renamed). Consent was
      // given at install time; repair silently.
      try {
        replaceWithSymlinkSync(bundledPath(), linkPath());
      } catch (err) {
        console.warn("[sgm-cli] link repair failed", err);
      }
    }
    return;
  }

  const config = await readGlobalConfig();
  if (config.sgmCliPromptDismissed === true) return;

  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Install the sgm command-line tool?",
    detail:
      "sgm is Shigoto no Mori's terminal companion: you (or a coding " +
      "agent) can create, list, and remove this app's worktrees from " +
      `any shell. This links sgm into ${displayDir(sgmUserBinDir())}; ` +
      "it runs straight from the app, so it's always in sync.",
    buttons: ["Install", "Not Now", "Don't Ask Again"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 2) {
    await writeGlobalConfig({ ...config, sgmCliPromptDismissed: true });
    return;
  }
  if (response !== 0) return;

  try {
    replaceWithSymlinkSync(bundledPath(), linkPath());
  } catch (err) {
    console.warn("[sgm-cli] install failed", err);
    await dialog.showMessageBox({
      type: "error",
      message: "Couldn't install sgm",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!isOnPath(sgmUserBinDir())) {
    await dialog.showMessageBox({
      type: "info",
      message: `sgm installed to ${displayDir(sgmUserBinDir())}`,
      detail:
        "That directory isn't on your PATH yet. Add this line to your " +
        `shell profile:\n\nexport PATH="${displayDir(sgmUserBinDir()).replace("~", "$HOME")}:$PATH"`,
    });
  }
}
