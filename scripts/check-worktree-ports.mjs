// Durable proof for the worktree port list's three pure-ish parts,
// under plain Node with no Electron and no git:
//   - the port-pool state reader (host/lib/portPool.ts) honours
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
// Runs under scripts/lib/register-ts-alias.mjs. See package.json
// "ports:check".
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolPortsFor } from "@host/lib/portPool";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import { dialLoopback, isLoopbackPortListening } from "@host/lib/net";
import { freeLoopbackPort, makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("worktree-ports proof");
console.log("worktree-ports proof\n");

function listenOn(host, track) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, host, () => {
      track(() => new Promise((done) => server.close(() => done())));
      resolve(server.address().port);
    });
  });
}

try {
  const dataHome = mkdtempSync(join(tmpdir(), "sm-ports-"));
  process.env.XDG_DATA_HOME = dataHome;
  mkdirSync(join(dataHome, "port-pool"));
  const statePath = join(dataHome, "port-pool", "state.json");

  await proof.check(
    "state reader: XDG_DATA_HOME, declared order, trailing slash, malformed entries skipped",
    async () => {
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
    },
  );

  await proof.check(
    "state reader: a corrupt state file reads as no allocations",
    async () => {
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
    },
  );

  await proof.check(
    "merge: pool rows first in declared order, a custom row on a pool number is shadowed",
    async () => {
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
    },
  );

  await proof.check(
    "probe: a 127.0.0.1 listener is seen, a closed port is not, within the deadline",
    async (track) => {
      const port = await listenOn("127.0.0.1", track);
      assert.equal(await isLoopbackPortListening(port, 500), true);
      const closed = await freeLoopbackPort();
      const started = Date.now();
      assert.equal(await isLoopbackPortListening(closed, 500), false);
      assert.ok(Date.now() - started < 500, "a refused dial answers at once");
    },
  );

  await proof.check(
    "dial: a v6-only listener is reached through the ::1 fallback",
    async (track) => {
      let port;
      try {
        port = await listenOn("::1", track);
      } catch (error) {
        if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") {
          proof.ok(
            "(no IPv6 loopback on this machine, fallback not exercised)",
          );
          return;
        }
        throw error;
      }
      const socket = await dialLoopback(port, 500);
      track(() => socket.destroy());
      assert.equal(socket.remoteAddress, "::1");
      assert.equal(await isLoopbackPortListening(port, 500), true);
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
}
