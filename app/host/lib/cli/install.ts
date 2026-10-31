// Install of the CLI as a symlink into a PATH bin dir, pointing at the
// binary the app itself runs. No copy means no version drift: when the
// binary updates, the link stays current. Flavor-aware: the packaged
// app manages `sm` linking its Resources binary. A dev run manages
// `smd` linking the checkout's dist-cli build (made by `pnpm dev`).
//
// Install and uninstall are user actions in Settings (the cli IPC
// module); the app never installs on its own. The only launch-time
// behavior is repairCliLinks: silently repointing a link the user
// already installed when its target moved, so an existing install
// keeps working across app updates and relocations.
//
// Naming and path policy lives in @shared/packaging/cliDist.mts; this
// module owns the link state machine and the "is that link ours?"
// judgment.
import { type Flavor, flavorNames } from "@shigomori/engine/flavor";
import { currentOf } from "@shigomori/engine/linuxInstall";
import { byPlatform } from "@shigomori/engine/platform";
import { lstat, readlink, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  replaceWithSymlinkSync,
  CLI_DIST_DIR,
  cliAliasName,
  cliBinaryName,
  cliUserBinDir,
} from "@shared/packaging/cliDist.mts";
import type { CliStatus } from "@shigomori/contracts/modules/cli";
import { cliBinaryOf } from "./binary";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { uninstallShellIntegration } from "./shell";
import * as HostFacts from "@host/lib/HostFacts";
import { log } from "@shared/log";
import { envSetting } from "@shared/config";

type Facts = HostFacts.HostFacts["Service"];

// Both command names the install manages: the short one (sm) and the
// spelled-out alias (shigomori). Both links point at the same binary.
function linkNames(flavor: Flavor): string[] {
  return [cliBinaryName(flavor), cliAliasName(flavor)];
}

function linkPath(flavor: Flavor): string {
  return join(cliUserBinDir(), cliBinaryName(flavor));
}

// What the links point at: the binary this app runs, but for a Linux
// install's, which they reach through `current` so they move on with
// an update.
function linkTarget(facts: Facts): string | null {
  const binary = cliBinaryOf(facts);
  if (binary === null || !facts.packaged) return binary;
  return byPlatform({
    darwin: binary,
    linux: join(currentOf(facts.resourcesPath), cliBinaryName(facts.flavor)),
  });
}

// The end of a link to this flavor's installed binary, wherever it is.
const installedEnding = (flavor: Flavor) =>
  byPlatform({
    darwin: `/Contents/Resources/${cliBinaryName(flavor)}`,
    linux: `/${flavorNames(flavor).configDir}/current/${cliBinaryName(flavor)}`,
  });

// What a link path points at, in decreasing closeness to "the binary
// this app runs":
//   missing      nothing at the path
//   this-binary  resolves to the running app's own binary
//   this-flavor  this flavor's binary in its expected home (an app
//                bundle's Resources when packaged, a checkout's
//                dist-cli in dev) at a location that has since moved
//   our-family   a shigomori-made link of the other kind, notably the
//                `sm -> <checkout>/dist-cli` link (pnpm cli:install)
//                that the prod app deliberately leaves to keep running
//                the checkout's build
//   foreign      anything else (a regular file, someone else's link);
//                never touched
// Call sites express strictness by which levels they accept.
type LinkOwnership =
  | "missing"
  | "this-binary"
  | "this-flavor"
  | "our-family"
  | "foreign";

async function linkOwnership(
  facts: Facts,
  link: string,
): Promise<LinkOwnership> {
  const stat = await lstat(link).catch(() => null);
  if (stat === null) return "missing";
  if (!stat.isSymbolicLink()) return "foreign";
  const target = await readlink(link).catch(() => null);
  if (target === null) return "foreign";
  const binary = linkTarget(facts);
  if (binary !== null && target === binary) {
    return "this-binary";
  }
  const name = cliBinaryName(facts.flavor);
  const bundleTarget = target.endsWith(installedEnding(facts.flavor));
  const distTarget = target.endsWith(`/${CLI_DIST_DIR}/${name}`);
  if (facts.packaged ? bundleTarget : distTarget) return "this-flavor";
  if (bundleTarget || distTarget) return "our-family";
  return "foreign";
}

function isOnPath(dir: string): boolean {
  return (envSetting("PATH") ?? "")
    .split(delimiter)
    .some((entry) => entry === dir);
}

// Gatekeeper app translocation (quarantined app run from ~/Downloads)
// mounts the bundle at a randomized read-only path that dies with the
// process. A link to it would dangle immediately.
function isTranslocated({ packaged, resourcesPath }: Facts): boolean {
  return packaged && resourcesPath.includes("/AppTranslocation/");
}

async function linkStatus(facts: Facts): Promise<CliStatus> {
  const binDir = cliUserBinDir();
  const base = {
    name: cliBinaryName(facts.flavor),
    aliasName: cliAliasName(facts.flavor),
    binDir,
    linkPath: linkPath(facts.flavor),
    foreignPaths: [] as string[],
    onPath: isOnPath(binDir),
  };
  // Both links must be healthy before Settings claims "Installed":
  // inspect each and report the worst state, with linkPath pointing at
  // the offending link so the foreign/stale copy names the right path.
  const severity = { installed: 0, missing: 1, stale: 2, foreign: 3 } as const;
  const links = await Promise.all(
    linkNames(facts.flavor).map(async (name) => {
      const link = join(binDir, name);
      return {
        link,
        state: stateOfOwnership(await linkOwnership(facts, link)),
      };
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
  const foreignPaths = links
    .filter((entry) => entry.state === "foreign")
    .map((entry) => entry.link);
  return { ...base, linkPath: worstLink, foreignPaths, state };
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
async function pointLinksAt(
  facts: Facts,
  binary: string,
  force: boolean,
): Promise<void> {
  await Promise.all(
    linkNames(facts.flavor).map(async (name) => {
      const link = join(cliUserBinDir(), name);
      if (!force && (await linkOwnership(facts, link)) === "foreign") return;
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
async function installLinks(facts: Facts, force: boolean): Promise<CliStatus> {
  const status = await linkStatus(facts);
  if (status.state === "foreign" && !force) {
    throw new Error(
      `${status.linkPath} already exists and wasn't created by ` +
        "Shigoto no Mori. Remove it first if you want the app to " +
        "manage the link.",
    );
  }
  if (isTranslocated(facts)) {
    throw new Error(
      "macOS is running this app from a temporary location (App " +
        "Translocation). Move it to Applications and relaunch, then " +
        "install.",
    );
  }
  const binary = linkTarget(facts);
  if (binary === null) throw new Error("No CLI binary is available to link.");
  await pointLinksAt(facts, binary, force);
  return linkStatus(facts);
}

// The links' state, and their install, for the handlers. A refusal
// crosses the wire in its own words.
export const cliLinkStatus = Effect.flatMap(HostFacts.HostFacts, (facts) =>
  Effect.tryPromise({ try: () => linkStatus(facts), catch: callFailureOf }),
);
export const installCliLinks = (force: boolean) =>
  Effect.flatMap(HostFacts.HostFacts, (facts) =>
    Effect.tryPromise({
      try: () => installLinks(facts, force),
      catch: callFailureOf,
    }),
  );

// Remove this flavor's links when they are recognizably shigomori-made.
// Anything else at the path stays. Accepts our-family on purpose: nuke
// should also take the checkout link the prod app otherwise refuses to
// manage.
async function uninstallCliLinks(facts: Facts): Promise<void> {
  await Promise.all(
    linkNames(facts.flavor).map(async (name) => {
      const link = join(cliUserBinDir(), name);
      const ownership = await linkOwnership(facts, link);
      if (ownership === "missing" || ownership === "foreign") return;
      await rm(link, { force: true }).catch(() => undefined);
    }),
  );
}

// The whole teardown, shared by the Settings uninstall action and
// "Nuke everything": shell hooks first, while the binary is still
// reachable, then the links. A hook failure must not strand the links,
// so unlinking always runs. The failure then surfaces afterwards
// rather than being swallowed: a hook left behind is inert (its guard
// line no-ops once the command is gone), yet the user should hear it
// stayed.
export const uninstallCliEverything = Effect.gen(function* () {
  const facts = yield* HostFacts.HostFacts;
  // No binary means the hook-removal spawn can't run. The guarded hook
  // line is inert without the command anyway, so skipping is not a
  // failure worth reporting.
  const hooks =
    cliBinaryOf(facts) === null
      ? Exit.void
      : yield* Effect.exit(uninstallShellIntegration);
  yield* Effect.promise(() => uninstallCliLinks(facts));
  return yield* hooks;
});

// Launch-time maintenance, never an install: when a link the user
// installed points at a copy of the app that is no longer the one
// running (updated bundle path, another checkout's dev build), repoint
// it. Consent was given at install time; failures only log.
export async function repairCliLinks(facts: Facts): Promise<void> {
  if (isTranslocated(facts)) return;
  const status = await linkStatus(facts);
  if (status.state !== "stale") return;
  const binary = linkTarget(facts);
  if (binary === null) return;
  try {
    await pointLinksAt(facts, binary, false);
  } catch (err) {
    log.warn("[cli] link repair failed", err);
  }
}
