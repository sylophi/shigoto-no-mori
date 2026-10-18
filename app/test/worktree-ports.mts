// Durable proof for the worktree port list's parts, under plain Node
// with no Electron:
//   - the port-pool state reader (host/lib/Ports.ts) honours
//     XDG_DATA_HOME, keeps the project's declared port order, tolerates
//     a trailing slash on the recorded directory, skips malformed
//     allocations and unknown fields, and reads a missing or corrupt
//     state file as "no allocations". What it read is kept 10 s on
//     both clocks: read again after a sleep or a forward step of the
//     wall clock, and never pinned by a backward one.
//   - a worktree's port-pool config that could not be read is read
//     again at the next ask, not taken for "not configured" for 10 s.
//   - the merge (shared/ports/mergeWorktreePorts.ts) lists pool rows first and
//     shadows a custom row on a pool-allocated number.
//   - the loopback probe and dial (host/lib/net.ts) see a listener on
//     127.0.0.1, fall back to ::1 for a v6-only listener, and report a
//     closed port as not listening within the deadline.
// Run: pnpm test worktree-ports.
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ops from "@host/lib/engineOps";
import * as Ports from "@host/lib/Ports";
import { addProject } from "@host/lib/projects";
import { initDataDirAt } from "@shared/paths";
import { builtNow, engineDataDir, runHost } from "./lib/hostRuntime.mts";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import { dialLoopback, isLoopbackPortListening } from "@host/lib/net";
import { errorCodeOf } from "@shigomori/contracts/errors";
import {
  freeLoopbackPort,
  sandboxGit,
  sleepingClock,
  startLoopbackServer,
  tempDir,
  testClock,
  type Track,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { beforeAll, it } from "vitest";

// The service as the host builds it with `dataHome` for XDG_DATA_HOME,
// its calls run on `clock`.
async function portsIn(dataHome: string, clock?: Clock.Clock) {
  process.env.XDG_DATA_HOME = dataHome;
  const ports = await runHost(
    Effect.provide(Effect.service(Ports.Ports), builtNow(Ports.layer)),
  );
  const on = <A,>(effect: Effect.Effect<A>) =>
    Effect.runPromise(
      clock === undefined
        ? effect
        : Effect.provideService(effect, Clock.Clock, clock),
    );
  return {
    poolPorts: (dir: string) => on(ports.poolPorts(dir)),
    active: (worktree: { projectId: string; worktreeId: string }) =>
      on(ports.portPoolActive(worktree)),
  };
}

async function listenOn(host: string, track: Track): Promise<number> {
  const server = await startLoopbackServer((socket) => socket.end(), { host });
  track(server.close);
  return server.port;
}

let dataHome: string;
let statePath: string;
let ports: Awaited<ReturnType<typeof portsIn>>;
beforeAll(async () => {
  dataHome = mkdtempSync(join(tmpdir(), "sm-ports-"));
  mkdirSync(join(dataHome, "port-pool"));
  statePath = join(dataHome, "port-pool", "state.json");
  ports = await portsIn(dataHome);
});

it("state reader: XDG_DATA_HOME, declared order, trailing slash, malformed entries skipped", async () => {
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 2,
      someFutureKey: true,
      allocations: [
        {
          dir: "/tmp/sm-ports/alpha/",
          ports: { api: 4100, web: 4000, db: 4200 },
          portOrder: ["web", "api", "db"],
          timestamp: 1,
        },
        { dir: "/tmp/sm-ports/beta", ports: { web: 4300 } },
        { dir: 42, ports: {} },
        "not an allocation",
      ],
    }),
  );
  assert.deepEqual(await ports.poolPorts("/tmp/sm-ports/alpha"), [
    { name: "web", port: 4000 },
    { name: "api", port: 4100 },
    { name: "db", port: 4200 },
  ]);
  assert.deepEqual(await ports.poolPorts("/tmp/sm-ports/beta/"), [
    { name: "web", port: 4300 },
  ]);
  assert.deepEqual(await ports.poolPorts("/tmp/sm-ports/gamma"), []);
});

it("state reader: a corrupt state file reads as no allocations", async () => {
  const corruptHome = mkdtempSync(join(tmpdir(), "sm-ports-corrupt-"));
  mkdirSync(join(corruptHome, "port-pool"));
  writeFileSync(join(corruptHome, "port-pool", "state.json"), "{nope");
  const corrupt = await portsIn(corruptHome);
  assert.deepEqual(await corrupt.poolPorts("/tmp/sm-ports/alpha"), []);
  assert.equal((await ports.poolPorts("/tmp/sm-ports/alpha")).length, 3);
});

it("state reader: what it read is kept 10 s on both clocks, read again after a sleep, and a backward step pins nothing", async () => {
  const home = tempDir("sm-ports-clocks-", trackTest);
  mkdirSync(join(home, "port-pool"));
  const allocate = (port: number) =>
    writeFileSync(
      join(home, "port-pool", "state.json"),
      JSON.stringify({
        allocations: [{ dir: "/tmp/sm-ports/a", ports: { web: port } }],
      }),
    );
  const webPort = async () =>
    (await clocked.poolPorts("/tmp/sm-ports/a"))[0]?.port;
  const clock = testClock();
  const { wall, sleep, stop } = sleepingClock(clock);
  const clocked = await portsIn(home, wall);
  allocate(4000);
  assert.equal(await webPort(), 4000);
  allocate(4001);
  assert.equal(await webPort(), 4000, "kept within its 10 s");
  // A sleep: the wall clock ran on, monotonic time stood.
  sleep(10_000);
  assert.equal(await webPort(), 4001, "read again after a sleep");
  // The wall clock stepped back an hour, then 10 s passed awake.
  allocate(4002);
  sleep(-3_600_000);
  await clock.advance(10_000);
  assert.equal(
    await webPort(),
    4002,
    "a backward step kept the allocations past their 10 s",
  );
  // Stopped: both clocks ran on.
  allocate(4003);
  stop(10_000);
  assert.equal(await webPort(), 4003);
});

it("config: a port-pool config that could not be read is read again at the next ask", async () => {
  initDataDirAt(engineDataDir);
  const root = tempDir("sm-ports-config-", trackTest);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = sandboxGit();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "a");
  const project = await runHost(addProject(repo));
  const [primary] = await runHost(
    Ops.listWorktreeIdentities({ projectId: project.id }),
  );
  assert.ok(primary !== undefined);
  await runHost(Ops.patchGlobalConfig({ portPool: true }));
  trackTest(() => runHost(Ops.patchGlobalConfig({ portPool: false })));
  // port-pool on PATH, as the service finds it when it is built.
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "port-pool"), "#!/bin/sh\n");
  chmodSync(join(bin, "port-pool"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  trackTest(() => {
    process.env["PATH"] = path;
  });
  const config = join(repo, "port-pool.config.json");
  // A directory where the file goes: the read fails.
  mkdirSync(config);
  const configured = await portsIn(dataHome);
  const worktree = { projectId: project.id, worktreeId: primary.id };
  assert.equal(await configured.active(worktree), false);
  rmSync(config, { recursive: true });
  writeFileSync(config, JSON.stringify({ schemaVersion: 1 }));
  assert.equal(
    await configured.active(worktree),
    true,
    "the failed read was kept as not configured",
  );
});

it("merge: pool rows first in declared order, a custom row on a pool number is shadowed", async () => {
  const merged = mergeWorktreePorts(
    [
      { name: "web", port: 4000 },
      { name: "api", port: 4100 },
    ],
    [
      { port: 4100, label: "old api" },
      { port: 9229, label: "inspector" },
      { port: 5555 },
    ],
  );
  assert.deepEqual(merged, [
    { port: 4000, label: "web", source: "pool" },
    { port: 4100, label: "api", source: "pool" },
    { port: 9229, label: "inspector", source: "custom" },
    { port: 5555, label: undefined, source: "custom" },
  ]);
});

it("probe: a 127.0.0.1 listener is seen, a closed port is not, within the deadline", async () => {
  const port = await listenOn("127.0.0.1", trackTest);
  assert.equal(await isLoopbackPortListening(port, 500), true);
  const closed = await freeLoopbackPort();
  const started = Date.now();
  assert.equal(await isLoopbackPortListening(closed, 500), false);
  assert.ok(Date.now() - started < 500, "a refused dial answers at once");
});

it("dial: a v6-only listener is reached through the ::1 fallback", async () => {
  let port;
  try {
    port = await listenOn("::1", trackTest);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
      console.log("(no IPv6 loopback on this machine, fallback not exercised)");
      return;
    }
    throw error;
  }
  const socket = await dialLoopback(port, 500);
  trackTest(() => socket.destroy());
  assert.equal(socket.remoteAddress, "::1");
  assert.equal(await isLoopbackPortListening(port, 500), true);
});
