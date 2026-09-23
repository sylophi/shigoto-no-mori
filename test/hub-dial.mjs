// Durable proof for the hub connection core's dial and lifecycle
// (shared/hub/connection.ts), driven under Effect's TestClock so the
// mint and accept deadlines and the backoff ladder run without sleeping
// real seconds. Pure: the socket is a fake HubSocketAdapter and the
// ticket mint is scripted, so no server and no network.
//
// Asserts:
//   - accept: a minted ticket rides the connect URL, the FIRST presence
//     envelope accepts (connected, the local device filtered out of the
//     roster), probe() pings the live socket, and a pong is not an
//     envelope.
//   - the mint deadline aborts a hanging mint and backs off without
//     opening a socket. A refused or revoked mint blocks and never
//     redials.
//   - the accept deadline terminates a half-open socket and redials
//     with a fresh ticket. A close before the accept blocks on the
//     revoked and superseded codes and retries on anything else.
//   - a drop after the accept tears the link down and redials, and one
//     after STABLE_CONNECTION_MS resets the ladder.
//   - stop() aborts a hanging mint, terminates a half-open socket (a
//     late presence on it moves nothing), and closes a live one (a late
//     close on it does not redial).
//   - refresh() is a no-op on the same opts, redials on different
//     ones, and restarts a blocked supervisor.
//   - the heartbeat kills a silent socket and reports the drop once.
//     The heartbeat runs on raw setInterval and Date.now
//     (shared/ipc/socket/heartbeat.ts), not the Effect clock, so that
//     one check uses a 20 ms real interval.
//   - no real time passes, apart from that heartbeat check.
//
// Fake sockets model the browser adapter (close only) unless a check
// asks for the node one (with terminate): the owner close of a
// terminate-bearing socket arms a real TERMINATE_GRACE_MS setTimeout
// that would hold the process open after the proof.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test hub-dial.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { createHubConnectionCore } from "@shared/hub/connection";
import { HubLinkDownError } from "@shared/hub/link";
import { HubRequestError } from "@shared/account/service";
import { HELLO_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import {
  CLOSE_DEVICE_REVOKED,
  CLOSE_SUPERSEDED,
  CONNECT_TICKET_PARAM,
  DEVICE_REVOKED_CODE,
  HUB_PING,
  HUB_PONG,
  HUB_ROUTES,
} from "@shared/hub/protocol";
import { STABLE_CONNECTION_MS } from "@shared/remote/supervisor";
import {
  captureWarnings,
  makeProof,
  promptly,
  settle as settleTurns,
  waitFor,
} from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("hub-dial proof");

const LOCAL = "A";
const OPTS = {
  hubUrl: "https://hub.example.test/",
  accountId: "acct-1",
  deviceId: LOCAL,
  appVersion: "1.0.0",
};
// A close code no hub classifier blocks on (a dropped network).
const CLOSE_ABNORMAL = 1006;
// Far past every rung, for "nothing ever redials".
const AN_HOUR = 60 * 60_000;
// Heartbeat timers that never fire inside a check, for every check but
// the heartbeat one.
const QUIET_HEARTBEAT = {
  intervalMs: AN_HOUR,
  timeoutMs: AN_HOUR,
  probeTimeoutMs: AN_HOUR,
};

const presence = (...online) => JSON.stringify({ t: "presence", online });
// Needs escaping in a query string, so the URL assertion proves the
// encoding and not only the presence of the ticket.
const ticketFor = (n) => `tk/${n} +=?&`;

// The mint is a promise the dial awaits, so a woken fiber needs a few
// more turns here than elsewhere.
const settle = () => settleTurns(8);

// One fake HubSocketAdapter per openSocket call, kept so a check can
// deliver text, fire the close and count what the core did to it.
function fakeSocket(url, { terminate }) {
  const socket = {
    url,
    sent: [],
    closes: 0,
    terminates: 0,
    messageHandlers: [],
    closeHandlers: [],
    send(text) {
      socket.sent.push(text);
    },
    close() {
      socket.closes += 1;
    },
    onMessage(handler) {
      socket.messageHandlers.push(handler);
    },
    onClose(handler) {
      socket.closeHandlers.push(handler);
    },
    deliver(text) {
      for (const handler of socket.messageHandlers) handler(text);
    },
    fireClose(code) {
      for (const handler of socket.closeHandlers) handler(code);
    },
  };
  if (terminate) {
    socket.terminate = () => {
      socket.terminates += 1;
    };
  }
  return socket;
}

// A mint that plays `script` one entry per call and repeats the last
// entry once it runs out. An entry is "hang" (settles only by aborting,
// which it records), { reject: error }, or { ticket } (the default:
// ticketFor(n), fresh per call).
function scriptedMint(script) {
  const mints = [];
  const mintTicket = (signal) => {
    const n = mints.length + 1;
    const entry = script[Math.min(n, script.length) - 1];
    const record = { n, aborted: false };
    mints.push(record);
    signal.addEventListener("abort", () => {
      record.aborted = true;
    });
    if (entry === "hang") {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    }
    if (entry.reject !== undefined) return Promise.reject(entry.reject);
    return Promise.resolve(entry.ticket ?? ticketFor(n));
  };
  return { mintTicket, mints };
}

// One core on its own TestClock runtime, torn down with the check.
function harness(
  track,
  { mint = [{}], terminate = false, heartbeat = QUIET_HEARTBEAT } = {},
) {
  const rt = ManagedRuntime.make(TestClock.layer());
  const { mintTicket, mints } = scriptedMint(mint);
  const sockets = [];
  const statuses = [];
  let changes = 0;
  const core = createHubConnectionCore({
    openSocket: (url) => {
      const socket = fakeSocket(url, { terminate });
      sockets.push(socket);
      return socket;
    },
    broker: { channel: "direct:connectInfo" },
    heartbeat,
    runtime: { runFork: rt.runFork, runPromise: rt.runPromise },
    onChange: () => {
      changes += 1;
      const { socket } = core.status();
      if (statuses.at(-1) !== socket) statuses.push(socket);
    },
  });
  track(async () => {
    await core.stop();
    await rt.dispose();
  });
  const opts = (overrides = {}) => ({ ...OPTS, mintTicket, ...overrides });
  return {
    core,
    mints,
    sockets,
    statuses,
    changes: () => changes,
    opts,
    phase: () => core.status().socket,
    lastSocket: () => sockets.at(-1),
    async refresh(next = opts()) {
      await promptly(
        core.refresh(async () => next),
        "refresh()",
      );
      await settle();
    },
    async adjust(ms) {
      await rt.runPromise(TestClock.adjust(ms));
      await settle();
    },
    async deliver(text, socket = sockets.at(-1)) {
      socket.deliver(text);
      await settle();
    },
    async fireClose(code, socket = sockets.at(-1)) {
      socket.fireClose(code);
      await settle();
    },
    // Dial and accept: a fresh mint, a socket, its first presence.
    async connect(online = [LOCAL, "B"]) {
      await this.refresh();
      await this.deliver(presence(...online));
      assert.deepEqual(this.phase(), CONNECTED);
    },
  };
}

const CONNECTED = {
  phase: "connected",
  remoteDeviceId: "",
  remoteAppVersion: "",
};
const CONNECTING = { phase: "connecting" };
const STOPPED = { phase: "stopped" };
const backoff = (attempt, delayMs) => ({ phase: "backoff", attempt, delayMs });
const REVOKED = {
  phase: "blocked",
  reason: "revoked",
  message: "this device was removed from the account, sign in again",
};
const SUPERSEDED = {
  phase: "blocked",
  reason: "superseded",
  message: "another instance of this device took over the device hub",
};

async function main() {
  const began = performance.now();
  // The heartbeat check runs on real timers. Its time is not the
  // TestClock's to save, so it comes off the wall-clock budget.
  let realTimeMs = 0;

  await check(
    "accept: the minted ticket rides the connect URL, the first presence accepts, probe() pings the live socket, a pong is no envelope",
    async (track) => {
      const warned = captureWarnings(track);
      const h = harness(track);
      await h.refresh();
      assert.equal(h.mints.length, 1);
      assert.equal(h.sockets.length, 1);
      const { url } = h.lastSocket();
      const ticket = ticketFor(1);
      assert.ok(url.includes(encodeURIComponent(ticket)), url);
      assert.equal(
        url,
        `wss://hub.example.test${HUB_ROUTES.connect.path}?${CONNECT_TICKET_PARAM}=${encodeURIComponent(ticket)}`,
      );
      const parsed = new URL(url);
      assert.equal(parsed.pathname, HUB_ROUTES.connect.path);
      assert.equal(parsed.searchParams.get(CONNECT_TICKET_PARAM), ticket);
      // Open but not accepted: still connecting, no roster.
      assert.deepEqual(h.phase(), CONNECTING);
      assert.deepEqual(h.core.status().onlineDeviceIds, []);

      await h.deliver(presence(LOCAL, "B", "C"));
      assert.deepEqual(h.phase(), CONNECTED);
      assert.deepEqual(h.core.status().onlineDeviceIds, ["B", "C"]);
      assert.deepEqual(h.statuses, [CONNECTING, CONNECTED]);

      // A later presence only replaces the roster.
      await h.deliver(presence(LOCAL, "C"));
      assert.deepEqual(h.core.status().onlineDeviceIds, ["C"]);
      assert.deepEqual(h.phase(), CONNECTED);

      const socket = h.lastSocket();
      assert.deepEqual(socket.sent, []);
      h.core.probe();
      assert.deepEqual(socket.sent, [HUB_PING]);
      const changes = h.changes();
      await h.deliver(HUB_PONG);
      assert.equal(h.changes(), changes, "a pong reached the link");
      assert.deepEqual(warned, [], "a pong was parsed as an envelope");
      assert.deepEqual(h.phase(), CONNECTED);
      assert.deepEqual(h.core.status().onlineDeviceIds, ["C"]);
      assert.equal(socket.closes + socket.terminates, 0);
    },
  );

  await check(
    "mint timeout: a hanging mint is aborted after HELLO_TIMEOUT_MS, no socket opens, and the supervisor backs off on the bottom rung",
    async (track) => {
      const h = harness(track, { mint: ["hang"] });
      await h.refresh();
      assert.deepEqual(h.phase(), CONNECTING);
      await h.adjust(HELLO_TIMEOUT_MS - 1);
      assert.equal(h.mints[0].aborted, false, "the mint aborted early");
      assert.deepEqual(h.phase(), CONNECTING);
      await h.adjust(1);
      assert.equal(h.mints[0].aborted, true, "the mint was not aborted");
      assert.equal(h.sockets.length, 0, "a timed-out mint opened a socket");
      assert.deepEqual(h.phase(), backoff(1, 1_000));
      assert.equal(h.mints.length, 1);
    },
  );

  await check(
    "mint refused: a 401/403 blocks as refused with the mint's message, a device_revoked one as revoked, no socket, no redial",
    async (track) => {
      const refused = harness(track, {
        mint: [{ reject: new HubRequestError("hub says no", 401) }],
      });
      await refused.refresh();
      assert.deepEqual(refused.phase(), {
        phase: "blocked",
        reason: "refused",
        message: "ticket mint failed: hub says no",
      });
      await refused.adjust(AN_HOUR);
      assert.equal(refused.mints.length, 1, "a refused mint redialed");
      assert.equal(refused.sockets.length, 0);

      const forbidden = harness(track, {
        mint: [{ reject: new HubRequestError("forbidden", 403) }],
      });
      await forbidden.refresh();
      assert.equal(forbidden.phase().reason, "refused");

      const revoked = harness(track, {
        mint: [
          {
            reject: new HubRequestError("revoked", 403, DEVICE_REVOKED_CODE),
          },
        ],
      });
      await revoked.refresh();
      assert.deepEqual(revoked.phase(), REVOKED);
      await revoked.adjust(AN_HOUR);
      assert.equal(revoked.mints.length, 1, "a revoked mint redialed");
      assert.equal(revoked.sockets.length, 0);

      // Not a refusal: a 500, or a fetch that never read a response,
      // retries on the ladder.
      const flaky = harness(track, {
        mint: [{ reject: new HubRequestError("hub down", 500) }],
      });
      await flaky.refresh();
      assert.deepEqual(flaky.phase(), backoff(1, 1_000));
      await flaky.adjust(1_000);
      assert.equal(flaky.mints.length, 2);
    },
  );

  await check(
    "accept timeout: a socket with no presence within HELLO_TIMEOUT_MS is terminated, backs off, then a fresh mint opens a second socket",
    async (track) => {
      const h = harness(track, { terminate: true });
      await h.refresh();
      const first = h.lastSocket();
      await h.adjust(HELLO_TIMEOUT_MS - 1);
      assert.equal(first.terminates, 0, "the accept deadline fired early");
      assert.deepEqual(h.phase(), CONNECTING);
      await h.adjust(1);
      assert.equal(first.terminates, 1);
      assert.equal(first.closes, 0);
      assert.deepEqual(h.phase(), backoff(1, 1_000));
      assert.equal(h.sockets.length, 1);
      // A presence landing on the killed socket accepts nothing.
      await h.deliver(presence(LOCAL, "B"), first);
      assert.deepEqual(h.phase(), backoff(1, 1_000));
      assert.deepEqual(h.core.status().onlineDeviceIds, []);

      await h.adjust(1_000);
      assert.equal(h.mints.length, 2);
      assert.equal(h.sockets.length, 2);
      assert.ok(h.lastSocket().url.endsWith(encodeURIComponent(ticketFor(2))));
      assert.deepEqual(h.phase(), CONNECTING);
      // Left unaccepted on purpose: the teardown's stop() terminates it.
      // An accepted node socket would be owner-closed instead, arming
      // the core's real TERMINATE_GRACE_MS timer past the proof's end.
    },
  );

  await check(
    "close before accept: 4102 blocks as revoked, 4103 as superseded, 1006 backs off and redials with a fresh ticket",
    async (track) => {
      const revoked = harness(track, { terminate: true });
      await revoked.refresh();
      await revoked.fireClose(CLOSE_DEVICE_REVOKED);
      assert.deepEqual(revoked.phase(), REVOKED);
      await revoked.adjust(AN_HOUR);
      assert.equal(revoked.mints.length, 1, "a revoked close redialed");
      assert.equal(revoked.sockets.length, 1);

      const superseded = harness(track, { terminate: true });
      await superseded.refresh();
      await superseded.fireClose(CLOSE_SUPERSEDED);
      assert.deepEqual(superseded.phase(), SUPERSEDED);
      await superseded.adjust(AN_HOUR);
      assert.equal(superseded.mints.length, 1, "a superseded close redialed");

      const dropped = harness(track, { terminate: true });
      await dropped.refresh();
      await dropped.fireClose(CLOSE_ABNORMAL);
      assert.deepEqual(dropped.phase(), backoff(1, 1_000));
      assert.equal(dropped.mints.length, 1);
      await dropped.adjust(1_000);
      assert.equal(dropped.mints.length, 2, "the redial reused a ticket");
      assert.equal(dropped.sockets.length, 2);
      assert.equal(
        new URL(dropped.lastSocket().url).searchParams.get(
          CONNECT_TICKET_PARAM,
        ),
        ticketFor(2),
      );
    },
  );

  await check(
    "drop after accept: backs off, tears the link down, redials; a drop after STABLE_CONNECTION_MS resets the ladder",
    async (track) => {
      const h = harness(track);
      await h.connect();
      assert.deepEqual(h.core.status().onlineDeviceIds, ["B"]);
      await h.fireClose(CLOSE_ABNORMAL);
      assert.deepEqual(h.phase(), backoff(1, 1_000));
      assert.deepEqual(h.core.status().onlineDeviceIds, []);
      await assert.rejects(h.core.connectBroker("B"), HubLinkDownError);

      // A second socket that drops at once climbs the ladder.
      await h.adjust(1_000);
      assert.equal(h.mints.length, 2);
      await h.deliver(presence(LOCAL, "B"));
      assert.deepEqual(h.phase(), CONNECTED);
      await h.fireClose(CLOSE_ABNORMAL);
      assert.deepEqual(h.phase(), backoff(2, 2_000));

      // A third that stays up the stable threshold resets it.
      await h.adjust(2_000);
      assert.equal(h.mints.length, 3);
      await h.deliver(presence(LOCAL, "B"));
      assert.deepEqual(h.phase(), CONNECTED);
      await h.adjust(STABLE_CONNECTION_MS);
      await h.fireClose(CLOSE_ABNORMAL);
      assert.deepEqual(h.phase(), backoff(1, 1_000));
      // The core never closed a socket the hub dropped.
      assert.deepEqual(
        h.sockets.map((socket) => socket.closes),
        [0, 0, 0],
      );
    },
  );

  await check(
    "stop: aborts a hanging mint, terminates a half-open socket, closes a live one, and nothing late moves it",
    async (track) => {
      // (a) A hanging mint.
      const minting = harness(track, { mint: ["hang"] });
      await minting.refresh();
      await promptly(minting.core.stop(), "stop() during a mint");
      assert.equal(minting.mints[0].aborted, true, "the mint was not aborted");
      assert.equal(minting.sockets.length, 0);
      assert.deepEqual(minting.phase(), STOPPED);
      await minting.adjust(AN_HOUR);
      assert.equal(minting.mints.length, 1, "a stopped core minted again");
      assert.equal(minting.sockets.length, 0);

      // (b) A half-open socket, and a presence landing on it late.
      const halfOpen = harness(track, { terminate: true });
      await halfOpen.refresh();
      const socket = halfOpen.lastSocket();
      await promptly(halfOpen.core.stop(), "stop() during the accept");
      assert.equal(socket.terminates, 1);
      assert.equal(socket.closes, 0);
      assert.deepEqual(halfOpen.phase(), STOPPED);
      const changes = halfOpen.changes();
      await halfOpen.deliver(presence(LOCAL, "B"), socket);
      assert.deepEqual(halfOpen.phase(), STOPPED);
      assert.deepEqual(halfOpen.core.status().onlineDeviceIds, []);
      assert.equal(halfOpen.changes(), changes, "a late presence notified");
      await halfOpen.adjust(AN_HOUR);
      assert.equal(halfOpen.mints.length, 1);

      // (c) A live socket, and a close landing on it late.
      const live = harness(track);
      await live.connect();
      const held = live.lastSocket();
      await promptly(live.core.stop(), "stop() while connected");
      assert.equal(held.closes, 1);
      assert.deepEqual(live.phase(), STOPPED);
      assert.deepEqual(live.core.status().onlineDeviceIds, []);
      await assert.rejects(live.core.connectBroker("B"), HubLinkDownError);
      await live.fireClose(CLOSE_ABNORMAL, held);
      await live.adjust(AN_HOUR);
      assert.equal(live.mints.length, 1, "a late close redialed");
      assert.deepEqual(live.phase(), STOPPED);
      assert.equal(held.closes, 1);
    },
  );

  await check(
    "refresh: the same opts while connected is a no-op, another account redials, and a blocked supervisor restarts",
    async (track) => {
      const h = harness(track);
      await h.connect();
      await h.refresh(h.opts());
      assert.equal(h.mints.length, 1, "a same-opts refresh minted");
      assert.equal(h.sockets.length, 1);
      assert.equal(h.lastSocket().closes, 0);
      assert.deepEqual(h.phase(), CONNECTED);

      const old = h.lastSocket();
      await h.refresh(h.opts({ accountId: "acct-2" }));
      assert.equal(old.closes, 1, "the old account's socket stayed open");
      assert.equal(h.mints.length, 2);
      assert.equal(h.sockets.length, 2);
      assert.deepEqual(h.phase(), CONNECTING);
      assert.deepEqual(h.statuses.slice(-3), [CONNECTED, STOPPED, CONNECTING]);
      await h.deliver(presence(LOCAL, "B"));
      assert.deepEqual(h.phase(), CONNECTED);

      // A null resolve stops it.
      await h.refresh(null);
      assert.deepEqual(h.phase(), STOPPED);
      assert.equal(h.lastSocket().closes, 1);

      const blocked = harness(track, {
        mint: [{ reject: new HubRequestError("no", 401) }, {}],
      });
      await blocked.refresh();
      assert.equal(blocked.phase().phase, "blocked");
      await blocked.refresh(blocked.opts());
      assert.equal(blocked.mints.length, 2, "refresh left it blocked");
      assert.equal(blocked.sockets.length, 1);
      await blocked.deliver(presence(LOCAL));
      assert.deepEqual(blocked.phase(), CONNECTED);
    },
  );

  await check(
    "heartbeat (real 20 ms timers): a silent socket is killed after the timeout and the drop is reported once",
    async (track) => {
      const started = performance.now();
      const h = harness(track, {
        terminate: true,
        heartbeat: { intervalMs: 20, timeoutMs: 60, probeTimeoutMs: AN_HOUR },
      });
      await h.connect();
      const socket = h.lastSocket();
      await waitFor(() => socket.terminates > 0, "the heartbeat kill", 2_000);
      await settle();
      realTimeMs = performance.now() - started;
      assert.ok(socket.sent.length >= 1);
      assert.ok(socket.sent.every((text) => text === HUB_PING));
      assert.equal(socket.terminates, 1);
      assert.equal(socket.closes, 0);
      assert.deepEqual(h.phase(), backoff(1, 1_000));
      assert.deepEqual(h.core.status().onlineDeviceIds, []);
      // The platform close the kill triggers reports nothing more.
      await h.fireClose(CLOSE_ABNORMAL, socket);
      assert.deepEqual(h.statuses, [CONNECTING, CONNECTED, backoff(1, 1_000)]);
      assert.equal(h.mints.length, 1);
      await h.adjust(1_000);
      assert.equal(h.mints.length, 2, "the heartbeat drop did not redial");
    },
  );

  const elapsed = performance.now() - began - realTimeMs;
  await check(
    "no real time passes: the deadlines and the ladder ran on the TestClock",
    () => {
      assert.ok(elapsed < 1_000, `the proof took ${Math.round(elapsed)} ms`);
    },
  );

  done();
}

main().catch(fail);
