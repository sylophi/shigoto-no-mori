// Install of the CLI as a symlink into a PATH bin dir, pointing at the
// binary the app itself runs -- the VS Code / Docker Desktop pattern.
// No copy means no version drift: when the binary updates, the link
// stays current. Flavor-aware: the packaged app manages `CLI` linking
// its Resources binary; a dev run manages `smd` linking the
// checkout's dist-cli build (made by `pnpm dev`).
//
// Install and uninstall are user actions in Settings (the cli IPC
// module); the app never installs on its own. The only launch-time
// behavior is repairCliLinks: silently repointing a link the user
// already installed when its target moved, so an existing install
// keeps working across app updates and relocations.
//
// Naming and path policy lives in @shared/cliDist.mts; this module
// owns the link state machine and the "is that link ours?" judgment.
//
// Not on Windows: the portable zip has no stable install location to
// link from, so Windows keeps the app-only workflow.
import { lstat, readlink, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  replaceWithSymlinkSync,
  CLI_DIST_DIR,
  cliAliasName,
  cliBinaryName,
  cliUserBinDir,
} from "@shared/cliDist.mts";
import type { CliStatus } from "@shared/ipc/modules/cli";
import { app } from "electron";
import { comparablePath } from "../lib/util/paths";
import { isWindows } from "../lib/util/platform";
import { cliBinaryPath } from "./cliRunner";

function cliFlavor(): "prod" | "dev" {
  return app.isPackaged ? "prod" : "dev";
}

function cliName(): string {
  return cliBinaryName(cliFlavor());
}

// Both command names the install manages: the short one (sm) and the
// spelled-out alias (shigomori). Both links point at the same binary.
function linkNames(): string[] {
  return [cliName(), cliAliasName(cliFlavor())];
}

function linkPath(): string {
  return join(cliUserBinDir(), cliName());
}

// What a link path points at, in decreasing closeness to "the binary
// this app runs":
//   missing      nothing at the path
//   this-binary  resolves to the running app's own binary
//   this-flavor  this flavor's binary in its expected home (an app
//                bundle's Resources when packaged, a checkout's
//                dist-cli in dev) at a location that has since moved
//   our-family   a shigomori-made link of the other kind -- notably
//                the `sm -> <checkout>/dist-cli` link (pnpm
//                cli:install) that the prod app deliberately leaves to
//                keep running the checkout's build
//   foreign      anything else (a regular file, someone else's link);
//                never touched
// Call sites express strictness by which levels they accept.
type LinkOwnership =
  | "missing"
  | "this-binary"
  | "this-flavor"
  | "our-family"
  | "foreign";

async function linkOwnership(link: string): Promise<LinkOwnership> {
  const stat = await lstat(link).catch(() => null);
  if (stat === null) return "missing";
  if (!stat.isSymbolicLink()) return "foreign";
  const target = await readlink(link).catch(() => null);
  if (target === null) return "foreign";
  const binary = isWindows ? null : cliBinaryPath();
  if (binary !== null && comparablePath(target) === comparablePath(binary)) {
    return "this-binary";
  }
  const name = cliName();
  const bundleTarget = target.endsWith(`/Contents/Resources/${name}`);
  const distTarget = target.endsWith(`/${CLI_DIST_DIR}/${name}`);
  if (app.isPackaged ? bundleTarget : distTarget) return "this-flavor";
  if (bundleTarget || distTarget) return "our-family";
  return "foreign";
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

export async function cliLinkStatus(): Promise<CliStatus> {
  const binDir = cliUserBinDir();
  const base = {
    name: cliName(),
    aliasName: cliAliasName(cliFlavor()),
    binDir,
    linkPath: linkPath(),
    onPath: isOnPath(binDir),
  };
  const binary = isWindows ? null : cliBinaryPath();
  if (binary === null) {
    return { ...base, supported: false, state: "missing" };
  }
  // Both links must be healthy before Settings claims "Installed":
  // inspect each and report the worst state, with linkPath pointing at
  // the offending link so the foreign/stale copy names the right path.
  const severity = { installed: 0, missing: 1, stale: 2, foreign: 3 } as const;
  const links = await Promise.all(
    linkNames().map(async (name) => {
      const link = join(binDir, name);
      return { link, state: stateOfOwnership(await linkOwnership(link)) };
    }),
  );
  let state: keyof typeof severity = "installed";
  let worstLink = base.linkPath;
  for (const entry of links) {
    if (severity[entry.state] > severity[state]) {
      state = entry.state;
      worstLink = entry.link;
    }
  }
  return { ...base, linkPath: worstLink, supported: true, state };
}

function stateOfOwnership(
  ownership: LinkOwnership,
): "installed" | "missing" | "stale" | "foreign" {
  switch (ownership) {
    case "missing":
      return "missing";
    case "this-binary":
      return "installed";
    case "this-flavor":
      return "stale";
    default:
      // our-family counts as foreign for the state machine: the prod
      // app reports (and refuses to manage) a checkout link.
      return "foreign";
  }
}

// Point both links at the binary. Without force, a foreign occupant
// stays untouched; any shigomori-made link (or an empty slot) gets
// (re)pointed at the running binary.
async function pointLinksAt(binary: string, force: boolean): Promise<void> {
  await Promise.all(
    linkNames().map(async (name) => {
      const link = join(cliUserBinDir(), name);
      if (!force && (await linkOwnership(link)) === "foreign") return;
      replaceWithSymlinkSync(binary, link);
    }),
  );
}

// Create (or, from "stale", repoint) the link. Throws with a
// user-facing message when there's nothing to link, the path is
// occupied by something that isn't ours, or the app is running from a
// translocated mount. force is the Settings "Replace and install"
// consent: it takes over a foreign occupant too, so a command that
// doesn't point at the app can be fixed without a trip to the shell.
export async function installCliLinks(force: boolean): Promise<CliStatus> {
  const status = await cliLinkStatus();
  if (!status.supported) {
    throw new Error("No CLI binary is available to link.");
  }
  if (status.state === "foreign" && !force) {
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
  const binary = cliBinaryPath();
  if (binary === null) throw new Error("No CLI binary is available to link.");
  await pointLinksAt(binary, force);
  return cliLinkStatus();
}

// Remove this flavor's links when they are recognizably shigomori-made.
// Anything else at the path stays. Shared by the Settings uninstall
// action and "Nuke everything". Accepts our-family on purpose: nuke
// should also take the checkout link the prod app otherwise refuses to
// manage.
export async function uninstallCliLinks(): Promise<void> {
  await Promise.all(
    linkNames().map(async (name) => {
      const link = join(cliUserBinDir(), name);
      const ownership = await linkOwnership(link);
      if (ownership === "missing" || ownership === "foreign") return;
      await rm(link, { force: true }).catch(() => undefined);
    }),
  );
}

// Launch-time maintenance, never an install: when a link the user
// installed points at a copy of the app that is no longer the one
// running (updated bundle path, another checkout's dev build), repoint
// it. Consent was given at install time; failures only log.
export async function repairCliLinks(): Promise<void> {
  if (isTranslocated()) return;
  const status = await cliLinkStatus();
  if (!status.supported || status.state !== "stale") return;
  const binary = cliBinaryPath();
  if (binary === null) return;
  try {
    await pointLinksAt(binary, false);
  } catch (err) {
    console.warn("[cli] link repair failed", err);
  }
}
