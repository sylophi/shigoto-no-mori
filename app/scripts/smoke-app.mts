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
// list offers. The app stages it on its own first check, consumes the
// install request `sm update` writes, and its installer swaps the new
// bundle in and opens it again, on the same temporary data folder.
//
// The release job runs it on the signed build; locally:
//
//   node scripts/smoke-app.mts "out/<app name>-darwin-arm64/<app name>.app"
//
// It uses the build's own userData and logs folder, which a launch
// creates, so run it where that build is not installed.

import { execFileSync, spawn } from "node:child_process";
import {
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
if (argument === undefined || !argument.endsWith(".app")) {
  console.error("usage: smoke-app.mts <path to the .app>");
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

async function stop(pid: number, exited: () => boolean): Promise<void> {
  process.kill(pid, "SIGTERM");
  if (!(await until(exited, QUIT_WITHIN_MS))) process.kill(pid, "SIGKILL");
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
  state: { kind: string; version?: string; message?: string };
};
const statusIn = (dataDir: string): AppStatus | null => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "updater.json"), "utf8"));
  } catch {
    return null;
  }
};

async function update(identity: string) {
  // Real, as the installer resolves the app's path before it opens it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sm-smoke-update-")));
  const dataDir = join(root, "data");
  const installed = join(root, "installed", `${appName}.app`);
  const release = join(root, "release", `${appName}.app`);
  const version = versionOf(bundle);
  const next = newerThan(version);
  execFileSync("ditto", [bundle, installed]);
  // Only the outer bundle is signed again, as its Info.plist changed.
  // Its nested code keeps the build's signatures.
  execFileSync("ditto", [bundle, release]);
  execFileSync("plutil", [
    "-replace",
    "CFBundleShortVersionString",
    "-string",
    next,
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
  const zipName = `${appName}-darwin-${process.arch}-${next}.zip`;
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
          tag_name: `v${next}`,
          prerelease: next.includes("-"),
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

  const child = spawn(executableIn(installed), [], {
    env: {
      ...process.env,
      SHIGOMORI_DATA_DIR: dataDir,
      SHIGOMORI_UPDATE_RELEASES_URL: `http://127.0.0.1:${port}/releases`,
    },
    stdio: "inherit",
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  let relaunched: number | null = null;
  const fail = (message: string): never => {
    printLogs(dataDir);
    throw new Error(`the update: ${message}`);
  };
  try {
    const started = Date.now();
    await until(() => {
      const kind = statusIn(dataDir)?.state.kind;
      return exited || kind === "ready" || kind === "error";
    }, STAGE_WITHIN_MS);
    const staged = statusIn(dataDir);
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

    // As `sm update` asks a running app: written whole, then renamed in.
    const requestedAt = Date.now();
    const request = join(dataDir, "updater-request.json");
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
    console.log(`the update: the app took the request and quit`);

    // The installer opens the new bundle through LaunchServices, so the
    // relaunched app is no child of ours: it is found by its executable.
    await until(() => {
      relaunched = runningFrom(executableIn(installed));
      return relaunched !== null;
    }, RESTART_WITHIN_MS);
    if (relaunched === null) fail("the installer didn't open the app again");
    if (versionOf(installed) !== next) {
      fail(`the app came back as ${versionOf(installed)}, not ${next}`);
    }
    const loopback = join(dataDir, "loopback.json");
    if (
      !(await until(
        () => existsSync(loopback) && statSync(loopback).mtimeMs > requestedAt,
        OPEN_WITHIN_MS,
      ))
    ) {
      fail("the relaunched app didn't open its store on the same data folder");
    }
    const leftovers = readdirSync(join(root, "installed")).filter(
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
    if (!exited && child.pid !== undefined) await stop(child.pid, () => exited);
    const again = relaunched;
    if (again !== null && pidAlive(again)) {
      await stop(again, () => !pidAlive(again));
    }
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

await launch("a data folder that does not exist", () => {});
await launch("a data folder holding an empty store.db", (dataDir) => {
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "store.db"), "");
});
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (identity === undefined || identity === "") {
  console.log(
    "the update: skipped, with no APPLE_SIGNING_IDENTITY to sign a newer copy",
  );
} else {
  await update(identity);
}
