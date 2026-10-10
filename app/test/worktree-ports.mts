// Durable proof for the worktree port list's three pure-ish parts,
// under plain Node with no Electron and no git:
//   - the port-pool state reader (host/lib/ports.ts) honours
//     XDG_DATA_HOME, keeps the project's declared port order, tolerates
//     a trailing slash on the recorded directory, skips malformed
//     allocations and unknown fields, and reads a missing or corrupt
//     state file as "no allocations" (cached per state path, so the
//     data-home switch is a real re-read).
//   - the merge (shared/ports/mergeWorktreePorts.ts) lists pool rows first and
//     shadows a custom row on a pool-allocated number.
//   - the loopback probe and dial (host/lib/net.ts) see a listener on
//     127.0.0.1, fall back to ::1 for a v6-only listener, and report a
//     closed port as not listening within the deadline.
// Run: pnpm test worktree-ports.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Ports from "@host/lib/ports";
import { runHost } from "./lib/adapters.mts";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import { dialLoopback, isLoopbackPortListening } from "@host/lib/net";
import { errorCodeOf } from "@shigomori/contracts/errors";
import {
  freeLoopbackPort,
  startLoopbackServer,
  type Track,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { beforeAll, it } from "vitest";

const poolPortsFor = (dir: string) =>
  runHost(Effect.flatMap(Ports.Ports, (ports) => ports.poolPorts(dir)));

async function listenOn(host: string, track: Track): Promise<number> {
  const server = await startLoopbackServer((socket) => socket.end(), { host });
  track(server.close);
  return server.port;
}

let dataHome: string;
let statePath: string;
beforeAll(() => {
  dataHome = mkdtempSync(join(tmpdir(), "sm-ports-"));
  process.env.XDG_DATA_HOME = dataHome;
  mkdirSync(join(dataHome, "port-pool"));
  statePath = join(dataHome, "port-pool", "state.json");
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
  assert.deepEqual(await poolPortsFor("/tmp/sm-ports/alpha"), [
    { name: "web", port: 4000 },
    { name: "api", port: 4100 },
    { name: "db", port: 4200 },
  ]);
  assert.deepEqual(await poolPortsFor("/tmp/sm-ports/beta/"), [
    { name: "web", port: 4300 },
  ]);
  assert.deepEqual(await poolPortsFor("/tmp/sm-ports/gamma"), []);
});

it("state reader: a corrupt state file reads as no allocations", async () => {
  // A fresh data home sidesteps the reader's TTL cache.
  const corruptHome = mkdtempSync(join(tmpdir(), "sm-ports-corrupt-"));
  mkdirSync(join(corruptHome, "port-pool"));
  writeFileSync(join(corruptHome, "port-pool", "state.json"), "{nope");
  process.env.XDG_DATA_HOME = corruptHome;
  // The reader caches per state path, so the switch of data home is
  // a fresh read, not a cached hit on the good file above.
  assert.deepEqual(await poolPortsFor("/tmp/sm-ports/alpha"), []);
  process.env.XDG_DATA_HOME = dataHome;
  assert.equal((await poolPortsFor("/tmp/sm-ports/alpha")).length, 3);
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
