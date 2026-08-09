// Launch-time install of the CLI as a symlink into a PATH bin dir,
// pointing at the binary the app itself runs -- the VS Code / Docker
// Desktop pattern. No copy means no version drift: when the binary
// updates, the link stays current. Flavor-aware: the packaged app
// offers `sgm` linking its Resources binary; a dev run offers `sgmd`
// linking the checkout's dist-cli build (made by `pnpm dev`). The
// first offer is a window-modal prompt (Install / Not Now / Don't Ask
// Again) that blocks the whole UI until answered -- installing never
// happens without an explicit yes, and the decision can't be clicked
// past. After that, a link we own is silently repaired if its target
// moved.
//
// Naming and path policy lives in @shared/sgmDist.mts; this module
// only owns the prompt flow and the "is that link ours?" judgment.
//
// Not on Windows: the portable zip has no stable install location to
// link from, so Windows keeps the app-only workflow.
import { lstat, readlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  replaceWithSymlinkSync,
  SGM_DIST_DIR,
  sgmBinaryName,
  sgmUserBinDir,
} from "@shared/sgmDist.mts";
import { app, type BrowserWindow, dialog } from "electron";
import { readGlobalConfig, writeGlobalConfig } from "../lib/config/global";
import { comparablePath } from "../lib/util/paths";
import { isWindows } from "../lib/util/platform";
import { sgmBinaryPath } from "./sgmRunner";

function cliName(): string {
  return sgmBinaryName(app.isPackaged ? "prod" : "dev");
}

// ~-abbreviated form for dialog text.
function displayDir(dir: string): string {
  const home = homedir();
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

function linkPath(): string {
  return join(sgmUserBinDir(), cliName());
}

// A link target is "ours" when it points at this flavor's binary in
// its expected home: some app bundle's Resources for `sgm`, some
// checkout's dist-cli for `sgmd` -- including a previous install from
// a location that has since moved. Anything else at the link path was
// put there by the user (their own build, another tool) and is never
// touched. Notably the prod app leaves a `sgm -> <checkout>/dist-cli`
// link (pnpm cli:install) alone: that was a deliberate choice to run
// the checkout's build.
function isOurTarget(target: string): boolean {
  const name = cliName();
  return app.isPackaged
    ? target.endsWith(`/Contents/Resources/${name}`)
    : target.endsWith(`/${SGM_DIST_DIR}/${name}`);
}

function isOnPath(dir: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((entry) => comparablePath(entry) === comparablePath(dir));
}

// "Nuke everything" counterpart: remove this flavor's CLI link when it
// is recognizably one shigomori created -- the app-bundle link this
// module installs, or a repo checkout's dist-cli link (pnpm
// cli:install, pnpm dev). Anything else at the path stays. The prod
// app removes `sgm`; the dev app removes `sgmd`.
export async function uninstallSgmCliLink(): Promise<void> {
  const name = sgmBinaryName(app.isPackaged ? "prod" : "dev");
  const link = join(sgmUserBinDir(), name);
  const stat = await lstat(link).catch(() => null);
  if (stat === null || !stat.isSymbolicLink()) return;
  const target = await readlink(link).catch(() => null);
  if (target === null) return;
  const ours =
    target.endsWith(`/Contents/Resources/${name}`) ||
    target.endsWith(`/${SGM_DIST_DIR}/${name}`);
  if (!ours) return;
  await rm(link, { force: true }).catch(() => undefined);
}

// Call after applyUserShellPath so the PATH check sees the login
// shell's PATH, not launchd's stripped one. Startup work (watchers,
// fetch, updater) proceeds underneath; only user interaction is held,
// as a modal sheet on `win`, until the prompt is answered. Failures
// only log.
export async function maybeInstallSgmCli(
  win: BrowserWindow | null,
): Promise<void> {
  const ask = (options: Electron.MessageBoxOptions) =>
    win === null || win.isDestroyed()
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(win, options);
  if (isWindows) return;
  // Resources/sgm when packaged, dist-cli/sgmd in dev; null means
  // there's no binary to link (dev run without a `pnpm dev` build).
  const binary = sgmBinaryPath();
  if (binary === null) return;
  // Gatekeeper app translocation (quarantined app run from ~/Downloads)
  // mounts the bundle at a randomized read-only path that dies with the
  // process -- a link to it would dangle immediately. The prompt will
  // fire on a later launch once the app lives somewhere real.
  if (app.isPackaged && process.resourcesPath.includes("/AppTranslocation/"))
    return;

  const existing = await lstat(linkPath()).catch(() => null);
  if (existing !== null) {
    if (!existing.isSymbolicLink()) return; // user's own binary; hands off
    const target = await readlink(linkPath()).catch(() => null);
    if (target === null) return;
    if (comparablePath(target) === comparablePath(binary)) return;
    if (isOurTarget(target)) {
      // Our link, stale target (app moved, was renamed, or sgmd points
      // at another checkout). Consent was given at install time; repair
      // silently to the binary this app actually runs.
      try {
        replaceWithSymlinkSync(binary, linkPath());
      } catch (err) {
        console.warn("[sgm-cli] link repair failed", err);
      }
    }
    return;
  }

  const config = await readGlobalConfig();
  if (config.sgmCliPromptDismissed === true) return;

  // Window-modal: the app is deliberately unusable until the user
  // decides. Any answer resolves it -- Install links, Not Now re-asks
  // next launch, Don't Ask Again persists the opt-out.
  const name = cliName();
  const { response } = await ask({
    type: "question",
    message: `Install the ${name} command-line tool?`,
    detail:
      `${name} is Shigoto no Mori's terminal companion: you (or a ` +
      "coding agent) can create, list, and remove this app's worktrees " +
      `from any shell. This links ${name} into ` +
      `${displayDir(sgmUserBinDir())}; it runs straight from the app, ` +
      "so it's always in sync.",
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
    replaceWithSymlinkSync(binary, linkPath());
  } catch (err) {
    console.warn("[sgm-cli] install failed", err);
    await ask({
      type: "error",
      message: `Couldn't install ${name}`,
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!isOnPath(sgmUserBinDir())) {
    await ask({
      type: "info",
      message: `${name} installed to ${displayDir(sgmUserBinDir())}`,
      detail:
        "That directory isn't on your PATH yet. Add this line to your " +
        `shell profile:\n\nexport PATH="${displayDir(sgmUserBinDir()).replace("~", "$HOME")}:$PATH"`,
    });
  }
}
