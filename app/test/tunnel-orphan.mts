// Durable proof for the reap of a dead host's cloudflared
// (host/direct/Tunnel.ts reapOrphanedConnector, run as the next host
// starts). Asserts:
//   - the process the pid file names is killed when it is cloudflared
//     (a stand-in: a link named cloudflared to sleep), and the file
//     goes,
//   - a process of another name under that pid is left running, as a
//     recycled pid, and the file goes, and so is a cloudflared born at
//     another time than the file records (another connector, the pid
//     handed on),
//   - a missing file is no failure, and one that is no pid, or names
//     launchd, signals nothing.
//
// Run: pnpm test tunnel-orphan.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import { reapOrphanedConnector } from "@host/direct/Tunnel";
import { tempDir } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const reap = (pidFile: string) =>
  Effect.runPromise(
    reapOrphanedConnector(pidFile).pipe(Effect.provide(NodeServices.layer)),
  );

// A process left to run, recorded in the pid file.
const recorded = (dir: string, command: string, born = "") => {
  const child = spawn(command, ["600"], { stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("exit", (_code, signal) => resolve(signal)),
  );
  trackTest(() => {
    child.kill("SIGKILL");
    return exited;
  });
  const pidFile = join(dir, "cloudflared.pid");
  writeFileSync(pidFile, `${child.pid}${born}\n`);
  // The signal that ended it: the reap's SIGKILL, or else the SIGTERM
  // sent here, so the proof never waits on an exit that isn't coming.
  const endedBy = () => {
    child.kill("SIGTERM");
    return exited;
  };
  return { pidFile, endedBy };
};

it("a dead host's cloudflared is killed and its pid file goes", async () => {
  const dir = tempDir("sm-tunnel-orphan-", trackTest);
  const standIn = join(dir, "cloudflared");
  symlinkSync("/bin/sleep", standIn);
  const { pidFile, endedBy } = recorded(dir, standIn);
  await reap(pidFile);
  assert.equal(existsSync(pidFile), false);
  assert.equal(await endedBy(), "SIGKILL");
});

it("a process of another name under the recorded pid is left running", async () => {
  const dir = tempDir("sm-tunnel-orphan-", trackTest);
  const { pidFile, endedBy } = recorded(dir, "/bin/sleep");
  await reap(pidFile);
  assert.equal(existsSync(pidFile), false);
  assert.equal(await endedBy(), "SIGTERM");
});

it("a cloudflared born at another time than the file records is left running", async () => {
  const dir = tempDir("sm-tunnel-orphan-", trackTest);
  const standIn = join(dir, "cloudflared");
  symlinkSync("/bin/sleep", standIn);
  // A birth long before this one's: the connector that wrote the
  // file is gone, and its pid went to another cloudflared.
  const { pidFile, endedBy } = recorded(dir, standIn, " 1000");
  await reap(pidFile);
  assert.equal(existsSync(pidFile), false);
  assert.equal(await endedBy(), "SIGTERM");
});

it("a missing pid file is no failure, and a corrupt one signals nothing", async () => {
  const dir = tempDir("sm-tunnel-orphan-", trackTest);
  const pidFile = join(dir, "cloudflared.pid");
  await reap(pidFile);
  for (const corrupt of ["no pid", "1", "-1"]) {
    writeFileSync(pidFile, `${corrupt}\n`);
    await reap(pidFile);
    assert.equal(existsSync(pidFile), false);
  }
});
