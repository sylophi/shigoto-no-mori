#!/usr/bin/env node
// Launches a packaged app and waits for its store to open, which only
// the app's own host does (node:sqlite in Electron, not the terminal's
// Bun). Twice, each on a data folder of its own: one that does not
// exist yet, and one holding the empty store.db a launch that could not
// open it left (v3.0.0-alpha.2). The store is open once SQLite has made
// its write-ahead log and the host its loopback file. The release job
// runs it on the signed build; locally:
//
//   node scripts/smoke-app.mts "out/<app name>-darwin-arm64/<app name>.app"
//
// It uses the build's own userData and logs folder, which a launch
// creates, so run it where that build is not installed.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const OPEN_WITHIN_MS = 60_000;
const QUIT_WITHIN_MS = 20_000;

const bundle = process.argv[2];
if (bundle === undefined || !bundle.endsWith(".app")) {
  console.error("usage: smoke-app.mts <path to the .app>");
  process.exit(2);
}
const appName = basename(bundle, ".app");
const executable = join(bundle, "Contents", "MacOS", appName);
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

function printLogs(): void {
  for (const file of ["main.log", "host-trace.log"]) {
    const path = join(logs, file);
    if (!existsSync(path)) continue;
    console.log(`--- ${file}`);
    console.log(readFileSync(path, "utf8").split("\n").slice(-40).join("\n"));
  }
}

async function launch(label: string, prepare: (dataDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "sm-smoke-"));
  const dataDir = join(root, "data");
  prepare(dataDir);
  const started = Date.now();
  const child = spawn(executable, [], {
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
    child.kill("SIGTERM");
    if (!(await until(() => exited, QUIT_WITHIN_MS))) child.kill("SIGKILL");
    await until(() => exited, QUIT_WITHIN_MS);
    rmSync(root, { recursive: true, force: true });
  }
}

await launch("a data folder that does not exist", () => {});
await launch("a data folder holding an empty store.db", (dataDir) => {
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "store.db"), "");
});
