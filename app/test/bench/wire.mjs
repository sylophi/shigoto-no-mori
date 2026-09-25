// Wire benchmark: the real direct listener (host/socket/server.ts) and
// the real client transport (shared/ipc/socket/wsClientTransport.ts)
// talking through a link shaped like an internet path
// (lib/shapedLink.mjs), so a change to the wire shows up as time and
// bytes instead of an argument. Not a proof: it asserts nothing and
// never runs in a hook.
//
//   pnpm test bench/wire
//   pnpm test bench/wire --rtt=120 --down=20 --up=5 --json
//   pnpm test bench/wire --tunnel
//
// --rtt is the round trip in ms, --down the host-to-client cap and
// --up the client-to-host cap, both in Mbit/s. The host's uplink is
// what a home connection runs out of first, so --down is the number
// that decides how long a big response takes. --tunnel swaps the
// shaped link for a real Cloudflare quick tunnel (the bundled
// cloudflared, `node scripts/fetch-cloudflared.mjs`), the same edge
// path a device's named tunnel takes: the numbers are then this
// machine's real uplink, and byte counts are not available.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createConnectTicketStore } from "@host/direct/tickets";
import { createWsServerBinding } from "@host/socket/server";
import { receiveBundleChunks } from "@host/lib/sync/fetchBundle";
import { sendBundleChunks } from "@host/lib/sync/pushBundle";
import { WIRE_CHUNK_BYTES } from "@shared/ipc/socket/frames";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
} from "@shared/packaging/cloudflaredDist.mts";
import { openDevice } from "@shared/ipc/socket/wsClientTransport";
import { delay, appRoot } from "../lib/checkKit.mjs";
import { startShapedLink } from "./lib/shapedLink.mjs";

function flag(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? fallback : Number(hit.split("=")[1]);
}
const rttMs = flag("rtt", 80);
const downMbit = flag("down", 20);
const upMbit = flag("up", 20);
const asJson = process.argv.includes("--json");
const viaTunnel = process.argv.includes("--tunnel");
// The A/B switch: a client that cannot inflate never asks for deflated
// frames (shared/ipc/socket/deflatedFrame.ts), which is the wire as it
// was before them.
const noDeflate = process.argv.includes("--no-deflate");
if (noDeflate) delete globalThis.DecompressionStream;

// A quick tunnel onto the binding: no account, a throwaway
// trycloudflare.com hostname that dies with the process. The binding
// behind it still demands a ticket proof.
function startQuickTunnel(targetPort) {
  const child = spawn(
    join(appRoot, CLOUDFLARED_DIST_DIR, CLOUDFLARED_BINARY_NAME),
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${targetPort}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Whatever ends this process, the connector goes with it.
  process.once("exit", () => child.kill("SIGTERM"));
  return new Promise((resolve, reject) => {
    let log = "";
    let host = null;
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`cloudflared exited\n${log}`)));
    child.stderr.on("data", (chunk) => {
      log += chunk;
      host ??= /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(log)?.[1];
      if (host != null && /Registered tunnel connection/.test(log)) {
        resolve({
          url: `wss://${host}`,
          counters: { up: 0, down: 0 },
          reset() {},
          close: () =>
            new Promise((done) => {
              child.removeAllListeners("exit");
              child.once("exit", done);
              child.kill("SIGTERM");
            }),
        });
      }
    });
  });
}

// A quick tunnel's hostname is minutes old at most, and the system
// resolver tends to have cached its absence from a dial made a moment
// too early. Asking a public resolver directly sidesteps that.
const publicResolver = new Resolver();
publicResolver.setServers(["1.1.1.1"]);
function publicLookup(hostname, options, callback) {
  publicResolver.resolve4(hostname, (error, addresses) => {
    if (error) callback(error);
    else if (options?.all) {
      callback(
        null,
        addresses.map((address) => ({ address, family: 4 })),
      );
    } else callback(null, addresses[0], 4);
  });
}

// Real payloads, so compressibility is what the app actually ships: a
// unified diff out of this repository's own history, and a list with
// the repeated keys every list response has.
function realDiff(maxBytes) {
  const text = execFileSync(
    "git",
    [
      "log",
      "-p",
      "-n",
      "40",
      "--no-color",
      "--",
      // Both layouts, so the sample spans history from before the app
      // moved into app/.
      ":(top)app/host",
      ":(top)app/shared",
      ":(top)host",
      ":(top)shared",
    ],
    { cwd: appRoot, encoding: "utf8", maxBuffer: 1 << 28 },
  );
  return text.slice(0, maxBytes);
}

function listPayload(count) {
  return Array.from({ length: count }, (_, i) => ({
    number: 1000 + i,
    title: `Fix the thing that broke in worktree ${i} after the rebase`,
    headRefName: `feature/branch-name-${i}`,
    baseRefName: "main",
    state: i % 3 === 0 ? "MERGED" : "OPEN",
    isDraft: i % 5 === 0,
    author: { login: `contributor-${i % 7}` },
    url: `https://github.com/example/repository/pull/${1000 + i}`,
    updatedAt: new Date(1_750_000_000_000 + i * 86_400_000).toISOString(),
    checks: { passing: i % 4, failing: i % 2, pending: 0 },
  }));
}

// A stand-in for the sync module's bundleChunk handler: the same
// offset-addressed, base64, eof-flagged answer, cut from incompressible
// bytes like the packed objects a real bundle is made of.
const BUNDLE_BYTES = 16 * WIRE_CHUNK_BYTES + 12_345;
const bundle = randomBytes(BUNDLE_BYTES);
function bundleChunk({ offset }) {
  const data = bundle.subarray(offset, offset + WIRE_CHUNK_BYTES);
  return {
    dataB64: data.toString("base64"),
    eof: offset + data.length >= BUNDLE_BYTES,
  };
}

const payloads = {
  small: { ok: true, branch: "main", ahead: 0, behind: 0 },
  list: listPayload(300),
  diff: { patch: realDiff(1_500_000) },
};

async function main() {
  // A connect ticket per dial, as the broker mints them. Every dial
  // arrives tunnel-borne (the shaped link carries the connector's
  // header, see connect below), so every ticket is the tunnel kind.
  const tickets = createConnectTicketStore();
  const binding = createWsServerBinding({
    matchTicket: (deviceId, arrivedAs, matches) =>
      tickets.consumeProven(deviceId, arrivedAs, matches),
    isCommandGranted: () => false,
  });
  for (const [name, value] of Object.entries(payloads)) {
    binding.handle(`bench:${name}`, async () => value, { gated: false });
  }
  binding.handle(
    "bench:bundleChunk",
    async (_ctx, input) => bundleChunk(input),
    {
      gated: false,
    },
  );
  binding.handle(
    "bench:pushChunk",
    async (_ctx, input) => {
      Buffer.from(input.dataB64, "base64");
    },
    { gated: false },
  );
  const port = await binding.start({
    port: 0,
    bindAddress: "127.0.0.1",
    deviceId: "bench-host",
    appVersion: "0.0.0",
  });
  const link = viaTunnel
    ? await startQuickTunnel(port)
    : await startShapedLink({
        targetPort: port,
        oneWayDelayMs: rttMs / 2,
        upBytesPerSec: (upMbit * 1_000_000) / 8,
        downBytesPerSec: (downMbit * 1_000_000) / 8,
      });

  const results = [];
  async function measure(name, fn) {
    link.reset();
    const started = performance.now();
    await fn();
    results.push({
      name,
      ms: Math.round(performance.now() - started),
      downBytes: link.counters.down,
      upBytes: link.counters.up,
    });
  }

  const connect = () =>
    openDevice({
      url: link.url,
      ticket: tickets.mint("bench-client", ["tunnel"])[0],
      appVersion: "0.0.0",
      localDeviceId: "bench-client",
      onClose: () => {},
      // The host deflates for tunnel-borne connections only, which it
      // tells by the header the local cloudflared adds. The shaped
      // link stands in for the tunnel, so it carries the header too.
      openSocket: (url) =>
        new WebSocket(url, {
          perMessageDeflate: false,
          ...(viaTunnel
            ? { lookup: publicLookup }
            : { headers: { "cf-connecting-ip": "203.0.113.7" } }),
        }),
    }).authenticate();
  // A quick tunnel's hostname takes a few seconds to resolve
  // everywhere, so the first dials can miss. Warm it, then measure.
  if (viaTunnel) {
    for (let attempt = 0; ; attempt++) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- a retry is sequential
        (await connect()).close();
        break;
      } catch (error) {
        if (attempt === 60) {
          throw new Error(`could not reach ${link.url}`, { cause: error });
        }
        // oxlint-disable-next-line no-await-in-loop -- a retry is sequential
        await delay(1_500);
      }
    }
  }
  let connection;
  await measure("connect (open + challenge + hello + welcome)", async () => {
    connection = await connect();
  });
  const deflate = noDeflate ? "off" : "on";
  const { transport } = connection;

  await measure("1 small invoke", () => transport.invoke("bench:small"));
  await measure("20 small invokes, sequential", async () => {
    for (let i = 0; i < 20; i++) {
      // oxlint-disable-next-line no-await-in-loop -- the waterfall is the point
      await transport.invoke("bench:small");
    }
  });
  await measure("20 small invokes, concurrent", () =>
    Promise.all(
      Array.from({ length: 20 }, () => transport.invoke("bench:small")),
    ),
  );
  await measure("list response (300 rows)", () =>
    transport.invoke("bench:list"),
  );
  await measure("diff response (1.5 MB patch)", () =>
    transport.invoke("bench:diff"),
  );
  await measure("small invoke queued behind a diff", async () => {
    const big = transport.invoke("bench:diff");
    const started = performance.now();
    await transport.invoke("bench:small");
    results.push({
      name: "  (the small one alone)",
      ms: Math.round(performance.now() - started),
      downBytes: 0,
      upBytes: 0,
    });
    await big;
  });

  // The bundle transfer, the way it was (one chunk per round trip) and
  // the way host/lib/sync/fetchBundle.ts drives it now.
  const peer = {
    bundleChunk: (input) => transport.invoke("bench:bundleChunk", input),
  };
  const sink = { write: async () => {} };
  const megabytes = (BUNDLE_BYTES / 1e6).toFixed(1);
  await measure(
    `${megabytes} MB bundle, one chunk per round trip`,
    async () => {
      for (let offset = 0, eof = false; !eof; offset += WIRE_CHUNK_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- the old loop, as it was
        ({ eof } = await peer.bundleChunk({ transferId: "bench", offset }));
      }
    },
  );
  await measure(`${megabytes} MB bundle, windowed`, () =>
    receiveBundleChunks(
      peer,
      { transferId: "bench", bytes: BUNDLE_BYTES },
      sink,
      () => {},
    ),
  );

  // The push direction (host/lib/sync/pushBundle.ts): the same bytes
  // going up, against a host that takes chunks one at a time and one
  // that takes them pipelined.
  const pushPeer = {
    pushChunk: (input) => transport.invoke("bench:pushChunk", input),
  };
  const source = {
    read: async (buffer, _at, length, offset) => ({
      bytesRead: bundle.copy(buffer, 0, offset, offset + length),
    }),
  };
  for (const pipelined of [false, true]) {
    // oxlint-disable-next-line no-await-in-loop -- one measurement at a time
    await measure(
      `${megabytes} MB push, ${pipelined ? "windowed" : "one chunk per round trip"}`,
      () =>
        sendBundleChunks(pushPeer, "bench", source, BUNDLE_BYTES, {
          pipelined,
        }),
    );
  }

  connection.close();
  await link.close();
  await binding.stop();

  if (asJson) {
    console.log(
      JSON.stringify({ viaTunnel, rttMs, downMbit, upMbit, deflate, results }),
    );
    return;
  }
  console.log(
    (viaTunnel
      ? "\nlink: Cloudflare quick tunnel"
      : `\nlink: ${rttMs} ms RTT, ${downMbit} Mbit/s down, ${upMbit} Mbit/s up`) +
      `, deflate ${deflate}\n`,
  );
  for (const row of results) {
    const bytes =
      row.downBytes === 0
        ? ""
        : `${(row.downBytes / 1024).toFixed(1)} KiB down`;
    console.log(
      `${row.name.padEnd(44)} ${String(row.ms).padStart(6)} ms   ${bytes}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
