// The command on PATH on Windows: a launcher under each command name in
// the install's bin folder (@shigomori/engine/windowsInstall), and that
// folder on the user's PATH (nativefs user-path). A dev run, or a
// packaged one that isn't installed, has no install to put the command
// in.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPath } from "@shigomori/engine/canonicalPath";
import { programFile } from "@shigomori/engine/executables";
import {
  windowsCliBinDir,
  windowsUpdateExe,
} from "@shigomori/engine/windowsInstall";
import type { CliStatus } from "@shigomori/contracts/modules/cli";
import { bundledBinaryPath } from "@shared/packaging/bundledBinary.mts";
import { cliAliasName, cliBinaryName } from "@shared/packaging/cliDist.mts";
import {
  CLI_LAUNCHER_BINARY_NAME,
  CLI_LAUNCHER_DIST_DIR,
} from "@shared/packaging/goHelpersDist.mts";
import {
  addToUserPath,
  onUserPath,
  removeCliLaunchers,
} from "@shared/cliLaunchers";
import { log } from "@shared/log";
import type { CliPlacement, Facts } from "./placement";

const isInstalled = (facts: Facts) =>
  facts.packaged && existsSync(windowsUpdateExe(facts.resourcesPath));

const launcherOf = (facts: Facts, name: string) =>
  join(windowsCliBinDir(facts.resourcesPath), programFile(name));

const launchersOf = (facts: Facts) =>
  [cliBinaryName(facts.flavor), cliAliasName(facts.flavor)].map((name) =>
    launcherOf(facts, name),
  );

const shippedLauncher = (facts: Facts) =>
  bundledBinaryPath(facts, CLI_LAUNCHER_DIST_DIR, CLI_LAUNCHER_BINARY_NAME);

async function status(facts: Facts): Promise<CliStatus> {
  const launchers = launchersOf(facts);
  const onPath =
    isInstalled(facts) &&
    launchers.every((launcher) => existsSync(launcher)) &&
    (await onUserPath(facts));
  return {
    name: cliBinaryName(facts.flavor),
    aliasName: cliAliasName(facts.flavor),
    binDir: canonicalPath(windowsCliBinDir(facts.resourcesPath)),
    commandPath: canonicalPath(launcherOf(facts, cliBinaryName(facts.flavor))),
    placement: "launcher",
    foreignPaths: [],
    onPath,
    state: onPath ? "installed" : "missing",
  };
}

async function placeLaunchers(facts: Facts): Promise<void> {
  await mkdir(windowsCliBinDir(facts.resourcesPath), { recursive: true });
  await Promise.all(
    launchersOf(facts).map((launcher) =>
      copyFile(shippedLauncher(facts), launcher),
    ),
  );
}

async function install(facts: Facts): Promise<CliStatus> {
  if (!isInstalled(facts)) {
    throw new Error(
      "Only an installed app puts the command line tool on PATH.",
    );
  }
  await placeLaunchers(facts);
  await addToUserPath(facts);
  return status(facts);
}

async function remove(facts: Facts): Promise<void> {
  if (isInstalled(facts)) removeCliLaunchers(facts);
}

// While PATH names the bin folder, its launchers are put back as
// shipped: an update can ship a new one, and Setup.exe run over the
// install empties the folder. One a terminal is running is replaced at
// a later start.
async function repair(facts: Facts): Promise<void> {
  try {
    if (!isInstalled(facts) || !(await onUserPath(facts))) return;
    const [shipped, ...placed] = await Promise.all(
      [shippedLauncher(facts), ...launchersOf(facts)].map((file) =>
        readFile(file).catch(() => null),
      ),
    );
    if (placed.every((bytes) => bytes !== null && shipped?.equals(bytes))) {
      return;
    }
    await placeLaunchers(facts);
  } catch (err) {
    log.warn("[cli] launcher repair failed", err);
  }
}

export const launchers: CliPlacement = { status, install, remove, repair };
