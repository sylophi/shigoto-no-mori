#!/usr/bin/env node
// Launches a packaged app and waits for its store to open, which only
// the app's own host does (node:sqlite in Electron, not the terminal's
// Bun). Twice, each on a data folder of its own: one that does not
// exist yet, and one holding the empty store.db a launch that could not
// open it left (v3.0.0-alpha.2). The store is open once SQLite has made
// its write-ahead log and the host its loopback file.
//
// Then, with APPLE_SIGNING_IDENTITY set (the updater installs only a
// bundle signed by the installed app's team), the update an installed
// app makes of itself: a copy of the build is the installed app, and a
// copy re-signed under a newer version is the release a local release
// list offers. The app stages it on its own first check. It consumes
// the install request `sm update` writes into an app folder the swap
// can't write, and comes back on the old version saying why. Then
// Settings' "Restart to update", pressed the way the window's button
// does (press-restart-to-update.mts), answers, and the installer swaps
// the new bundle in and opens it again, on the same temporary data
// folder.
//
// The release job runs it on the signed build; locally, on a test
// flavor's (`SM_FLAVOR=lab pnpm package`, app/lab/dev-app.md):
//
//   node scripts/smoke-app.mts "out/<app name>-darwin-arm64/<app name>.app"
//
// With --serve <port>, a test flavor's build is then left running on a
// fresh data folder with its debugging port open there, for weblab to
// attach to as to the dev app, until this script is stopped.
//
// With --update-installed <installed .app> <its data dir>, the step
// before a cut instead (V3.md, "Process"): the app installed on this
// machine, running and signed in, takes the build through Restart to
// update (updateInstalled, below).
//
// It uses the build's own userData and logs folder, which a launch
// creates, so run it where that build is not installed, and nuke a
// test flavor's after (`<its binary> nuke --yes`).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const OPEN_WITHIN_MS = 60_000;
const QUIT_WITHIN_MS = 20_000;
// The app's first check waits a minute out (main/electron/updater.ts),
// then downloads and verifies.
const STAGE_WITHIN_MS = 4 * 60_000;
const RESTART_WITHIN_MS = 2 * 60_000;

const argument = process.argv[2];
const mode = process.argv[3];
const serveAt = mode === "--serve" ? process.argv[4] : undefined;
const installedAt =
  mode === "--update-installed"
    ? { app: process.argv[4] ?? "", dataDir: process.argv[5] ?? "" }
    : undefined;
if (
  argument === undefined ||
  !argument.endsWith(".app") ||
  (mode === "--serve" && !/^\d+$/.test(serveAt ?? "")) ||
  (mode === "--update-installed" &&
    (!installedAt?.app.endsWith(".app") || installedAt.dataDir === "")) ||
  (mode !== undefined && mode !== "--serve" && mode !== "--update-installed")
) {
  console.error(
    "usage: smoke-app.mts <path to the .app> [--serve <port> | --update-installed <installed .app> <its data dir>]",
  );
  process.exit(2);
}
const bundle: string = argument;
const appName = basename(bundle, ".app");
const executableIn = (app: string) => join(app, "Contents", "MacOS", appName);
const logs = join(homedir(), "Library", "Logs", appName);

async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling the folder
    await sleep(250);
  }
  return done();
}

function printLogs(dataDir?: string): void {
  const files = ["main.log", "host-trace.log"].map((file) => join(logs, file));
  if (dataDir !== undefined) {
    files.push(join(dataDir, "updater.json"));
    files.push(join(dataDir, "updates", "install.log"));
  }
  for (const path of files) {
    if (!existsSync(path)) continue;
    console.log(`--- ${path}`);
    console.log(readFileSync(path, "utf8").split("\n").slice(-40).join("\n"));
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A signal to a process gone already is no failure of the smoke's.
const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {}
};

async function stop(pid: number, exited: () => boolean): Promise<void> {
  if (exited()) return;
  signal(pid, "SIGTERM");
  if (!(await until(exited, QUIT_WITHIN_MS))) signal(pid, "SIGKILL");
  await until(exited, QUIT_WITHIN_MS);
}

async function launch(label: string, prepare: (dataDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "sm-smoke-"));
  const dataDir = join(root, "data");
  prepare(dataDir);
  const started = Date.now();
  const child = spawn(executableIn(bundle), [], {
    env: { ...process.env, SHIGOMORI_DATA_DIR: dataDir },
    stdio: "inherit",
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  try {
    const open = await until(
      () =>
        exited ||
        (existsSync(join(dataDir, "store.db-wal")) &&
          existsSync(join(dataDir, "loopback.json"))),
      OPEN_WITHIN_MS,
    );
    if (!open || exited) {
      printLogs();
      throw new Error(
        `${label}: the store did not open within ${OPEN_WITHIN_MS / 1000} s${exited ? " (the app exited)" : ""}`,
      );
    }
    console.log(`${label}: the store opened in ${Date.now() - started} ms`);
  } finally {
    if (child.pid !== undefined) await stop(child.pid, () => exited);
    rmSync(root, { recursive: true, force: true });
  }
}

const plist = (app: string) => join(app, "Contents", "Info.plist");
const versionOf = (app: string) =>
  execFileSync(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist(app)],
    { encoding: "utf8" },
  ).trim();

// A version above `version` on the same line: a prerelease gains a
// field (3.0.0-alpha.7 to 3.0.0-alpha.7.1), a full release a patch.
function newerThan(version: string): string {
  if (version.includes("-")) return `${version}.1`;
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

type AppStatus = {
  pid: number;
  appVersion: string;
  state: {
    kind: string;
    version?: string;
    message?: string;
    install?: boolean;
  };
};
const statusIn = (dataDir: string): AppStatus | null => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "updater.json"), "utf8"));
  } catch {
    return null;
  }
};

// A copy of `build` signed again under `version`, zipped in `root` as
// a release's asset, and a local release list offering it.
async function serveRelease(
  build: string,
  version: string,
  identity: string,
  root: string,
) {
  const release = join(root, "release", `${appName}.app`);
  // Only the outer bundle is signed again, as its Info.plist changed.
  // Its nested code keeps the build's signatures.
  execFileSync("ditto", [build, release]);
  execFileSync("plutil", [
    "-replace",
    "CFBundleShortVersionString",
    "-string",
    version,
    plist(release),
  ]);
  execFileSync("codesign", [
    "--force",
    "--sign",
    identity,
    "--timestamp=none",
    "--preserve-metadata=entitlements,requirements,flags,runtime",
    release,
  ]);
  const zipName = `${appName}-darwin-${process.arch}-${version}.zip`;
  const zip = join(root, zipName);
  execFileSync("ditto", ["-c", "-k", "--keepParent", release, zip]);
  rmSync(join(root, "release"), { recursive: true, force: true });

  const server = createServer((request, response) => {
    if (request.url === "/zip") {
      response.writeHead(200, { "Content-Length": statSync(zip).size });
      createReadStream(zip).pipe(response);
      return;
    }
    const { port } = server.address() as AddressInfo;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify([
        {
          tag_name: `v${version}`,
          prerelease: version.includes("-"),
          body: "",
          published_at: new Date().toISOString(),
          assets: [
            {
              name: zipName,
              browser_download_url: `http://127.0.0.1:${port}/zip`,
            },
          ],
        },
      ]),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/releases`, server };
}

// Settings' "Restart to update", pressed as the window's button does
// (press-restart-to-update.mts): its answer, or why it failed.
function pressRestartToUpdate(dataDir: string): string | null {
  const pressed = spawnSync(
    "bun",
    [join(import.meta.dirname, "press-restart-to-update.mts"), dataDir],
    // Long enough for a busy app's dialog to be answered.
    { encoding: "utf8", timeout: RESTART_WITHIN_MS },
  );
  if (pressed.error !== undefined) {
    return `the press didn't answer: ${pressed.error.message}`;
  }
  const said = pressed.stdout.trim();
  try {
    const outcome = JSON.parse(said) as { answer?: unknown; failed?: string };
    return "failed" in outcome
      ? (outcome.failed ?? "")
      : outcome.answer === null
        ? null
        : `it answered ${JSON.stringify(outcome.answer)}`;
  } catch {
    return `the press printed ${JSON.stringify(said)} (${pressed.stderr.trim()})`;
  }
}

async function update(identity: string) {
  // Real, as the installer resolves the app's path before it opens it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-smoke-update-")));
  const dataDir = join(root, "data");
  const installedDir = join(root, "installed");
  const installed = join(installedDir, `${appName}.app`);
  const version = versionOf(bundle);
  const next = newerThan(version);
  execFileSync("ditto", [bundle, installed]);
  const { url, server } = await serveRelease(bundle, next, identity, root);

  const child = spawn(executableIn(installed), [], {
    env: {
      ...process.env,
      SHIGOMORI_DATA_DIR: dataDir,
      SHIGOMORI_UPDATE_RELEASES_URL: url,
    },
    stdio: "inherit",
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  // The apps the installer opened, through LaunchServices: no children
  // of ours, found by their executable.
  const opened = new Set<number>();
  const fail: (message: string) => never = (message) => {
    printLogs(dataDir);
    throw new Error(`the update: ${message}`);
  };
  // Until the app publishes `kind` (or an error), or `gone` says it went.
  const untilState = async (kind: string, gone: () => boolean) => {
    await until(() => {
      const state = statusIn(dataDir)?.state.kind;
      return gone() || state === kind || state === "error";
    }, STAGE_WITHIN_MS);
    return statusIn(dataDir);
  };
  try {
    const started = Date.now();
    const staged = await untilState("ready", () => exited);
    if (staged?.state.kind !== "ready") {
      fail(
        exited
          ? "the app exited before it staged the update"
          : staged?.state.kind === "error"
            ? `the app couldn't stage ${next}: ${staged.state.message}`
            : `the app didn't stage ${next} within ${STAGE_WITHIN_MS / 1000} s`,
      );
    }
    console.log(
      `the update: the app staged ${next} in ${Date.now() - started} ms`,
    );

    // As `sm update` asks a running app (written whole, then renamed in),
    // into a folder the swap can't write: the installer's reason must
    // reach the app it brings back.
    const requestedAt = Date.now();
    const request = join(dataDir, "updater-request.json");
    chmodSync(installedDir, 0o555);
    writeFileSync(
      `${request}.tmp`,
      JSON.stringify({ action: "install", requestedAt }),
    );
    renameSync(`${request}.tmp`, request);
    if (!(await until(() => exited, RESTART_WITHIN_MS))) {
      fail(
        existsSync(request)
          ? "the app never took the install request"
          : "the app took the install request and didn't quit",
      );
    }
    const back = await until(() => {
      const status = statusIn(dataDir);
      return status !== null && status.pid !== child.pid;
    }, RESTART_WITHIN_MS);
    const restored = statusIn(dataDir);
    if (restored !== null) opened.add(restored.pid);
    chmodSync(installedDir, 0o755);
    if (!back)
      fail("the installer didn't bring the app back after its swap failed");
    const failed = await untilState("error", () => false);
    if (failed?.state.kind !== "error" || failed.state.install !== true) {
      fail(
        `the app came back without the installer's reason: ${JSON.stringify(failed?.state)}`,
      );
    }
    if (versionOf(installed) !== version) {
      fail(`a failed swap left ${versionOf(installed)} installed`);
    }
    console.log(
      `the update: a swap that couldn't write came back as ${version}, saying "${failed.state.message}"`,
    );

    // The installer opened it with the data folder alone, so its first
    // check, a minute in, would ask the real feed and drop the staged
    // update. Started again on the local list before then, it has the
    // update ready from the start; then Settings' button, the way the
    // window presses it.
    await stop(failed.pid, () => !pidAlive(failed.pid));
    const again = spawn(executableIn(installed), [], {
      env: {
        ...process.env,
        SHIGOMORI_DATA_DIR: dataDir,
        SHIGOMORI_UPDATE_RELEASES_URL: url,
      },
      stdio: "inherit",
    });
    const pid = again.pid ?? 0;
    opened.add(pid);
    await until(() => {
      const status = statusIn(dataDir);
      return (
        !pidAlive(pid) || (status?.pid === pid && status.state.kind === "ready")
      );
    }, OPEN_WITHIN_MS);
    const ready = statusIn(dataDir);
    if (ready?.pid !== pid || ready.state.kind !== "ready") {
      fail(
        `the app started again didn't have ${next} ready: ${JSON.stringify(ready?.state)}`,
      );
    }
    const pressedAt = Date.now();
    const refused = pressRestartToUpdate(dataDir);
    if (refused !== null) fail(`Restart to update failed: ${refused}`);
    if (!(await until(() => !pidAlive(pid), RESTART_WITHIN_MS))) {
      fail("the app answered Restart to update and didn't quit");
    }
    console.log("the update: Restart to update answered, and the app quit");

    await until(
      () => runningFrom(executableIn(installed)) !== null,
      RESTART_WITHIN_MS,
    );
    const relaunched = runningFrom(executableIn(installed));
    if (relaunched === null) fail("the installer didn't open the app again");
    opened.add(relaunched);
    if (versionOf(installed) !== next) {
      fail(`the app came back as ${versionOf(installed)}, not ${next}`);
    }
    const loopback = join(dataDir, "loopback.json");
    if (
      !(await until(
        () => existsSync(loopback) && statSync(loopback).mtimeMs > pressedAt,
        OPEN_WITHIN_MS,
      ))
    ) {
      fail("the relaunched app didn't open its store on the same data folder");
    }
    const leftovers = readdirSync(installedDir).filter(
      (name) => name !== `${appName}.app`,
    );
    if (leftovers.length > 0) fail(`the swap left ${leftovers.join(", ")}`);
    const stagedDir = join(dataDir, "updates", "staged");
    if (existsSync(stagedDir) && readdirSync(stagedDir).length > 0) {
      fail("the swap left the update staged");
    }
    console.log(
      `the update: ${version} swapped for ${next} and opened again (pid ${relaunched})`,
    );
  } finally {
    chmodSync(installedDir, 0o755);
    if (!exited && child.pid !== undefined) await stop(child.pid, () => exited);
    await Promise.all(
      [...opened].map((pid) => stop(pid, () => !pidAlive(pid))),
    );
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// The pid of a process running `executable`, if one is.
function runningFrom(executable: string): number | null {
  const line = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.replace(/^\d+\s+/, "").startsWith(executable));
  return line === undefined ? null : Number.parseInt(line, 10);
}

// The step before a cut (V3.md, "Process"): the app installed on this
// machine, signed in on its own data folder, takes the candidate
// `bundle` through Settings' button and comes back on it, signed in. The
// candidate is built as the next version up from the installed one, so
// the release cut after it is still an update, and offered from a local
// release list the app is started on. The relaunch is on the real feed
// again.
async function updateInstalled(
  identity: string,
  installed: string,
  dataDir: string,
) {
  const version = versionOf(installed);
  const next = newerThan(version);
  // The app reads its version from the bundle's package.json, which a
  // signature can't change: the build has to be made at it.
  if (versionOf(bundle) !== next) {
    throw new Error(
      `the build is ${versionOf(bundle)}: make it as ${next} (pnpm -C app pkg set version=${next} before packaging)`,
    );
  }
  const resources = join(installed, "Contents", "Resources");
  const binary = readdirSync(resources).find((name) => /^sm\w*$/.test(name));
  if (binary === undefined) throw new Error(`no sm binary in ${resources}`);
  const signedIn = () => {
    const devices = spawnSync(join(resources, binary), ["--json", "devices"], {
      encoding: "utf8",
    });
    return devices.status === 0 && devices.stdout.includes('"thisDevice"');
  };
  const fail: (message: string) => never = (message) => {
    printLogs(dataDir);
    throw new Error(`the installed app's update: ${message}`);
  };
  const before = statusIn(dataDir);
  if (before === null || !pidAlive(before.pid)) {
    fail(`${installed} isn't running on ${dataDir}`);
  }
  if (!signedIn()) fail("the installed app isn't signed in");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-candidate-")));
  const { url, server } = await serveRelease(bundle, next, identity, root);
  try {
    // Quit as the menu's Quit does (a busy app asks first), and started
    // again on the local release list.
    const bundleId = execFileSync(
      "plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist(installed)],
      { encoding: "utf8" },
    ).trim();
    execFileSync("osascript", [
      "-e",
      `tell application id "${bundleId}" to quit`,
    ]);
    const quitting = before.pid;
    if (!(await until(() => !pidAlive(quitting), STAGE_WITHIN_MS))) {
      fail("the installed app didn't quit");
    }
    execFileSync("open", [
      "-a",
      installed,
      "--env",
      `SHIGOMORI_UPDATE_RELEASES_URL=${url}`,
    ]);
    await until(() => {
      const status = statusIn(dataDir);
      return (
        status !== null &&
        status.pid !== quitting &&
        status.state.kind === "ready" &&
        status.state.version === next
      );
    }, STAGE_WITHIN_MS);
    const ready = statusIn(dataDir);
    if (ready?.state.kind !== "ready" || ready.state.version !== next) {
      fail(`the app didn't stage ${next}: ${JSON.stringify(ready?.state)}`);
    }
    console.log(
      `the installed app: ${next} staged, pressing Restart to update`,
    );
    const refused = pressRestartToUpdate(dataDir);
    if (refused !== null) fail(`Restart to update failed: ${refused}`);
    const back = await until(() => {
      const status = statusIn(dataDir);
      return (
        status !== null &&
        status.pid !== ready.pid &&
        pidAlive(status.pid) &&
        status.appVersion === next &&
        versionOf(installed) === next
      );
    }, RESTART_WITHIN_MS);
    if (!back) {
      fail(
        `the app didn't come back as ${next} (it is ${versionOf(installed)})`,
      );
    }
    if (!(await until(signedIn, OPEN_WITHIN_MS))) {
      fail(`the app came back as ${next}, signed out`);
    }
    console.log(
      `the installed app: ${version} updated to ${next} through Restart to update, and back signed in`,
    );
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const identity = process.env.APPLE_SIGNING_IDENTITY;
if (installedAt !== undefined) {
  if (identity === undefined || identity === "") {
    console.error(
      "--update-installed signs the candidate: set APPLE_SIGNING_IDENTITY",
    );
    process.exit(2);
  }
  await updateInstalled(identity, installedAt.app, installedAt.dataDir);
  process.exit(0);
}

await launch("a data folder that does not exist", () => {});
await launch("a data folder holding an empty store.db", (dataDir) => {
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "store.db"), "");
});
// Up on a data folder of its own, the port open, until stopped.
async function serve(port: string) {
  const root = mkdtempSync(join(tmpdir(), "sm-serve-"));
  const dataDir = join(root, "data");
  const child = spawn(executableIn(bundle), [], {
    env: {
      ...process.env,
      SHIGOMORI_DATA_DIR: dataDir,
      SHIGOMORI_DEBUG_PORT: port,
    },
    stdio: "inherit",
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const stopped = new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    child.once("exit", () => resolve());
  });
  console.log(`serving on 127.0.0.1:${port}, the data folder ${dataDir}`);
  await stopped;
  if (child.pid !== undefined) await stop(child.pid, () => exited);
  rmSync(root, { recursive: true, force: true });
}

if (identity === undefined || identity === "") {
  console.log(
    "the update: skipped, with no APPLE_SIGNING_IDENTITY to sign a newer copy",
  );
} else {
  await update(identity);
}
if (serveAt !== undefined) await serve(serveAt);
