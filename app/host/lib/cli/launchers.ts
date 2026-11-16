// The command on PATH on Windows: a launcher under each command name in
// the install's bin folder (@shigomori/engine/windowsInstall), and that
// folder on the user's PATH (nativefs user-path). A dev run, or a
// packaged one that isn't installed, has no install to put the command
// in.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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
  NATIVEFS_BINARY_NAME,
  NATIVEFS_DIST_DIR,
} from "@shared/packaging/goHelpersDist.mts";
import { removeCliLaunchers } from "@shared/cliLaunchers";
import { log } from "@shared/log";
import type { CliPlacement, Facts } from "./placement";

const run = promisify(execFile);

const isInstalled = (facts: Facts) =>
  facts.packaged && existsSync(windowsUpdateExe(facts.resourcesPath));

const launchersOf = (facts: Facts) =>
  [cliBinaryName(facts.flavor), cliAliasName(facts.flavor)].map((name) =>
    join(windowsCliBinDir(facts.resourcesPath), programFile(name)),
  );

const shippedLauncher = (facts: Facts) =>
  bundledBinaryPath(facts, CLI_LAUNCHER_DIST_DIR, CLI_LAUNCHER_BINARY_NAME);

const userPath = (facts: Facts, verb: "has" | "add") =>
  run(bundledBinaryPath(facts, NATIVEFS_DIST_DIR, NATIVEFS_BINARY_NAME), [
    "user-path",
    verb,
    windowsCliBinDir(facts.resourcesPath),
  ]);

const onUserPath = async (facts: Facts) =>
  (await userPath(facts, "has")).stdout.trim() === "true";

async function status(facts: Facts): Promise<CliStatus> {
  const launchers = launchersOf(facts);
  const onPath =
    isInstalled(facts) &&
    launchers.every((launcher) => existsSync(launcher)) &&
    (await onUserPath(facts));
  return {
    name: cliBinaryName(facts.flavor),
    aliasName: cliAliasName(facts.flavor),
    binDir: windowsCliBinDir(facts.resourcesPath),
    linkPath: launchers[0] ?? "",
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
  await userPath(facts, "add");
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
