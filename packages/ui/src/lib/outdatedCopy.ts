// What a device on another release of the app can't do with this one,
// said to a person (contracts' README.md, "Wire samples").
import type { OutdatedSide } from "@shigomori/contracts/errors";
import { listed } from "@shigomori/contracts/words";
import type { RemoteDeviceStatus } from "./deviceStatus.ts";

// A module as a person reads it, mid-sentence, where its own name
// doesn't do. Modules that read as one thing share a name.
const MODULE_NAMES: Record<string, string> = {
  updater: "updates",
  account: "device switches",
  sharing: "device switches",
  worktreeData: "worktrees",
  git: "Git status",
  githubCli: "pull requests",
  fs: "folder browsing",
  shigomori: "project settings",
  packageScripts: "package scripts",
  mirror: "mirror and move",
  sync: "mirror and move",
  forward: "port forwarding",
  portPool: "port pool",
  globalConfig: "settings",
  sharedSettings: "shared settings",
  cli: "CLI install",
  agents: "agent hooks",
  runtime: "data folder",
  hygiene: "storage",
  terrier: "Terrier",
};

// As many as a banner's line names before it counts the rest.
const NAMED = 4;

// "terminals, scripts and 3 more".
function modulesListed(modules: readonly string[]): string {
  const names = [
    ...new Set(modules.map((module) => MODULE_NAMES[module] ?? module)),
  ];
  return names.length <= NAMED
    ? listed(names)
    : listed([
        ...names.slice(0, NAMED - 1),
        `${names.length - NAMED + 1} more`,
      ]);
}

// What stands between this device and a peer on another release of
// the app, until the older of the two updates: what of the peer can't
// be used from here over a session to it, or that the two are too far
// apart to hold one.
export function outdatedNote(
  label: string,
  status: Extract<RemoteDeviceStatus, { outdated: OutdatedSide }>,
): string {
  if (status.phase === "outdated") {
    return status.outdated === "peer"
      ? `${label} runs a version of Shigoto no Mori too old to connect to. Update it from ${label} itself.`
      : `This device runs a version of Shigoto no Mori too old to connect to ${label}. Update this device.`;
  }
  const what = modulesListed(status.modules);
  return status.outdated === "peer"
    ? `${label} runs an older version of Shigoto no Mori. Until it updates, its ${what} can't be used from here.`
    : `This device runs an older version of Shigoto no Mori than ${label}. Until it updates, it can't use ${label}'s ${what}.`;
}

// One action a peer on another release of the app can't take (a
// ModuleOutdatedError), for its toast.
export function outdatedCallNote(
  label: string,
  outdated: OutdatedSide,
): string {
  return outdated === "peer"
    ? `${label} runs an older version of Shigoto no Mori. Update it to do this.`
    : `This device runs an older version of Shigoto no Mori than ${label}. Update this device to do this.`;
}
