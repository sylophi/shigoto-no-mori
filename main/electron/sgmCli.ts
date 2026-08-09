// Install of the CLI as a symlink into a PATH bin dir, pointing at the
// binary the app itself runs -- the VS Code / Docker Desktop pattern.
// No copy means no version drift: when the binary updates, the link
// stays current. Flavor-aware: the packaged app manages `sgm` linking
// its Resources binary; a dev run manages `sgmd` linking the
// checkout's dist-cli build (made by `pnpm dev`).
//
// Install and uninstall are user actions in Settings (the sgmCli IPC
// module); the app never installs on its own. The only launch-time
// behavior is repairSgmCliLink: silently repointing a link the user
// already installed when its target moved, so an existing install
// keeps working across app updates and relocations.
//
// Naming and path policy lives in @shared/sgmDist.mts; this module
// owns the link state machine and the "is that link ours?" judgment.
//
// Not on Windows: the portable zip has no stable install location to
// link from, so Windows keeps the app-only workflow.
import { lstat, readlink, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  replaceWithSymlinkSync,
  SGM_DIST_DIR,
  sgmBinaryName,
  sgmUserBinDir,
} from "@shared/sgmDist.mts";
import type { SgmCliStatus } from "@shared/ipc/modules/sgmCli";
import { app } from "electron";
import { comparablePath } from "../lib/util/paths";
import { isWindows } from "../lib/util/platform";
import { sgmBinaryPath } from "./sgmRunner";

function cliName(): string {
  return sgmBinaryName(app.isPackaged ? "prod" : "dev");
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

// Gatekeeper app translocation (quarantined app run from ~/Downloads)
// mounts the bundle at a randomized read-only path that dies with the
// process -- a link to it would dangle immediately.
function isTranslocated(): boolean {
  return app.isPackaged && process.resourcesPath.includes("/AppTranslocation/");
}

export async function sgmCliStatus(): Promise<SgmCliStatus> {
  const binDir = sgmUserBinDir();
  const base = {
    name: cliName(),
    binDir,
    linkPath: linkPath(),
    onPath: isOnPath(binDir),
  };
  const binary = isWindows ? null : sgmBinaryPath();
  if (binary === null) {
    return { ...base, supported: false, state: "missing" };
  }
  const stat = await lstat(base.linkPath).catch(() => null);
  if (stat === null) return { ...base, supported: true, state: "missing" };
  if (!stat.isSymbolicLink()) {
    return { ...base, supported: true, state: "foreign" };
  }
  const target = await readlink(base.linkPath).catch(() => null);
  if (target === null) return { ...base, supported: true, state: "foreign" };
  if (comparablePath(target) === comparablePath(binary)) {
    return { ...base, supported: true, state: "installed" };
  }
  if (isOurTarget(target)) {
    return { ...base, supported: true, state: "stale" };
  }
  return { ...base, supported: true, state: "foreign" };
}

// Create (or, from "stale", repoint) the link. Throws with a
// user-facing message when there's nothing to link, the path is
// occupied by something that isn't ours, or the app is running from a
// translocated mount.
export async function installSgmCliLink(): Promise<SgmCliStatus> {
  const status = await sgmCliStatus();
  if (!status.supported) {
    throw new Error("No CLI binary is available to link.");
  }
  if (status.state === "foreign") {
    throw new Error(
      `${status.linkPath} already exists and wasn't created by ` +
        "Shigoto no Mori. Remove it first if you want the app to " +
        "manage the link.",
    );
  }
  if (isTranslocated()) {
    throw new Error(
      "macOS is running this app from a temporary location (App " +
        "Translocation). Move it to Applications and relaunch, then " +
        "install.",
    );
  }
  const binary = sgmBinaryPath();
  if (binary === null) throw new Error("No CLI binary is available to link.");
  replaceWithSymlinkSync(binary, linkPath());
  return sgmCliStatus();
}

// Remove this flavor's link when it is recognizably one shigomori
// created -- the app-bundle link, or a checkout's dist-cli link (pnpm
// cli:install, settings install in dev). Anything else at the path
// stays. Shared by the Settings uninstall action and "Nuke
// everything". The suffix set here is broader than isOurTarget on
// purpose: nuke should also take the checkout link the prod app
// otherwise refuses to manage.
export async function uninstallSgmCliLink(): Promise<void> {
  const name = cliName();
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

// Launch-time maintenance, never an install: when a link the user
// installed points at a copy of the app that is no longer the one
// running (updated bundle path, another checkout's dev build), repoint
// it. Consent was given at install time; failures only log.
export async function repairSgmCliLink(): Promise<void> {
  if (isTranslocated()) return;
  const status = await sgmCliStatus();
  if (!status.supported || status.state !== "stale") return;
  const binary = sgmBinaryPath();
  if (binary === null) return;
  try {
    replaceWithSymlinkSync(binary, linkPath());
  } catch (err) {
    console.warn("[sgm-cli] link repair failed", err);
  }
}
