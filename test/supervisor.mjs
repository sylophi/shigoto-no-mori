// Durable proof for the reconnect supervisor (shared/remote/supervisor.ts),
// driven under Effect's TestClock so the ladder runs without sleeping
// real seconds. Pure: no sockets, the connect function is a stub.
//
// Asserts:
//   - a dial that keeps failing walks the backoff ladder exactly
//     (BACKOFF_LADDER_MS, then capped at the last rung), with a
//     connecting status between rungs and nothing happening a
//     millisecond before a rung's delay is up.
//   - a socket that stayed open STABLE_CONNECTION_MS resets the ladder
//     on its drop, and one that drops sooner climbs on.
//   - a blocking close code (through the injected classifier) and a
//     blocked dial failure end the loop with the verdict and no further
//     dial, however far the clock runs.
//   - stop() cancels a hanging dial, closes a held connection once,
//     cuts a backoff sleep short, and marks a never-started supervisor
//     stopped; onConnection sees the connection and its loss.
//   - start() is idempotent, and a start() after stop() begins at the
//     bottom rung.
//   - no real time passes.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test supervisor.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Effect, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import {
  BACKOFF_LADDER_MS,
  STABLE_CONNECTION_MS,
  createSupervisor,
} from "@shared/remote/supervisor";
import { RemoteConnectError } from "@shared/ipc/socket/wsClientTransport";
import { CLOSE_AUTH_FAILED } from "@shared/ipc/socket/frames";
import { makeProof } from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("supervisor proof");

const PARAMS = {
  url: "ws://127.0.0.1:1/",
  token: "t",
  appVersion: "1.0.0",
  localDeviceId: "local",
};

// A close code no classifier here blocks on (the abnormal-closure code
// a dropped network produces).
const CLOSE_ABNORMAL = 1006;
const CLOSE_REVOKED = 4100;

// The forked loop runs on Effect's scheduler, which dispatches on
// setImmediate. A few turns let a fiber woken by start(), a close or a
// clock adjustment reach its next status before an assertion reads it.
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- turns are sequential by nature
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Fails the check instead of hanging the process when a promise that
// should settle at once (a stop() under a frozen clock) never does.
async function promptly(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle`)), 500);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function fakeConnection(remoteDeviceId) {
  const connection = {
    remoteDeviceId,
    remoteAppVersion: "2.0.0",
    closes: 0,
    close() {
      connection.closes += 1;
    },
    probe() {},
    channels: {},
    transport: {},
  };
  return connection;
}

const retryable = (message = "dial failed") =>
  Effect.fail(new RemoteConnectError(message, null, false));

// A connect stub that plays `script` one entry per dial and repeats the
// last entry once it runs out. Each entry is (opts) => Effect. `dials`
// keeps every dial's options, so a check can close the socket a dial
// produced through its onClose.
function scriptedConnect(script) {
  const dials = [];
  const connect = (opts) => {
    dials.push(opts);
    return script[Math.min(dials.length, script.length) - 1](opts);
  };
  return { connect, dials, lastDial: () => dials.at(-1) };
}

// One supervisor on its own TestClock runtime, torn down with the check.
function harness(track, { script, classifyClose }) {
  const rt = ManagedRuntime.make(TestClock.layer());
  const { connect, dials, lastDial } = scriptedConnect(script);
  const statuses = [];
  const connections = [];
  const supervisor = createSupervisor({
    params: PARAMS,
    connect,
    classifyClose,
    onStatus: (status) => statuses.push(status),
    onConnection: (connection) => connections.push(connection),
    runtime: { runFork: rt.runFork, runPromise: rt.runPromise },
  });
  track(async () => {
    await supervisor.stop();
    await rt.dispose();
  });
  async function adjust(ms) {
    await rt.runPromise(TestClock.adjust(ms));
    await settle();
  }
  async function start() {
    supervisor.start();
    await settle();
  }
  return { supervisor, statuses, connections, dials, lastDial, adjust, start };
}

const CONNECTING = { phase: "connecting" };
const STOPPED = { phase: "stopped" };
const backoff = (attempt, delayMs) => ({ phase: "backoff", attempt, delayMs });
const connected = (remoteDeviceId) => ({
  phase: "connected",
  remoteDeviceId,
  remoteAppVersion: "2.0.0",
});

async function main() {
  const began = performance.now();

  await check(
    "ladder: a dial that keeps failing walks BACKOFF_LADDER_MS exactly, then holds at the last rung, and no rung fires a millisecond early",
    async (track) => {
      const h = harness(track, { script: [() => retryable()] });
      await h.start();
      // The first dial runs at once on start(), with no delay.
      assert.deepEqual(h.statuses, [CONNECTING, backoff(1, 1_000)]);
      assert.equal(h.dials.length, 1);

      const last = BACKOFF_LADDER_MS.at(-1);
      const expected = [...BACKOFF_LADDER_MS, last, last];
      for (let rung = 1; rung < expected.length; rung += 1) {
        const delayMs = expected[rung - 1];
        const seen = h.statuses.length;
        // oxlint-disable-next-line no-await-in-loop -- the ladder is sequential
        await h.adjust(delayMs - 1);
        assert.equal(h.statuses.length, seen, `rung ${rung} fired early`);
        assert.equal(h.dials.length, rung, `rung ${rung} dialed early`);
        assert.deepEqual(h.supervisor.status(), backoff(rung, delayMs));
        // oxlint-disable-next-line no-await-in-loop -- the ladder is sequential
        await h.adjust(1);
        assert.deepEqual(h.statuses.slice(seen), [
          CONNECTING,
          backoff(rung + 1, expected[rung]),
        ]);
        assert.equal(h.dials.length, rung + 1);
      }
      assert.deepEqual(
        h.statuses
          .filter((status) => status.phase === "backoff")
          .map((status) => status.delayMs),
        expected,
      );
      assert.deepEqual(h.connections, [], "a failed dial reported a socket");
    },
  );

  await check(
    "defect: a dial that dies (a thrown bug, not a typed failure) backs off like a failed dial instead of ending the loop in connecting",
    async (track) => {
      const warned = [];
      const warn = console.warn;
      console.warn = (line) => warned.push(String(line));
      track(() => {
        console.warn = warn;
      });
      const h = harness(track, {
        script: [
          () => Effect.die(new Error("dial bug")),
          () =>
            Effect.sync(() => {
              throw new Error("thrown bug");
            }),
          () => retryable(),
        ],
      });
      await h.start();
      assert.deepEqual(h.statuses, [CONNECTING, backoff(1, 1_000)]);
      await h.adjust(1_000);
      assert.deepEqual(h.statuses.slice(2), [CONNECTING, backoff(2, 2_000)]);
      await h.adjust(2_000);
      assert.equal(h.dials.length, 3, "the loop stopped after the defects");
      assert.deepEqual(h.supervisor.status(), backoff(3, 4_000));
      assert.ok(
        warned.some((line) => line.includes("dial died")),
        "the defect went unlogged",
      );
    },
  );

  await check(
    "stable reset: a socket open STABLE_CONNECTION_MS resets the ladder on its drop, one that drops sooner climbs on",
    async (track) => {
      // Two failures climb to rung 3, then a socket stays up exactly the
      // stable threshold and drops: the next backoff is the bottom rung.
      const stable = fakeConnection("peer");
      const s = harness(track, {
        script: [
          () => retryable(),
          () => retryable(),
          () => Effect.succeed(stable),
        ],
      });
      await s.start();
      await s.adjust(1_000);
      await s.adjust(2_000);
      assert.deepEqual(s.statuses, [
        CONNECTING,
        backoff(1, 1_000),
        CONNECTING,
        backoff(2, 2_000),
        CONNECTING,
        connected("peer"),
      ]);
      await s.adjust(STABLE_CONNECTION_MS);
      assert.deepEqual(s.supervisor.status(), connected("peer"));
      s.lastDial().onClose(CLOSE_ABNORMAL);
      await settle();
      assert.deepEqual(s.statuses.slice(6), [backoff(1, 1_000)]);
      assert.equal(stable.closes, 0, "the supervisor closed a dropped socket");

      // The same climb, but the socket drops a millisecond short of the
      // threshold: the ladder carries on at rung 3.
      const flaky = fakeConnection("peer");
      const u = harness(track, {
        script: [
          () => retryable(),
          () => retryable(),
          () => Effect.succeed(flaky),
        ],
      });
      await u.start();
      await u.adjust(1_000);
      await u.adjust(2_000);
      assert.deepEqual(u.supervisor.status(), connected("peer"));
      await u.adjust(STABLE_CONNECTION_MS - 1);
      u.lastDial().onClose(CLOSE_ABNORMAL);
      await settle();
      assert.deepEqual(u.statuses.slice(6), [backoff(3, 4_000)]);
      assert.equal(u.dials.length, 3);
    },
  );

  await check(
    "blocked: a close the classifier names, and a blocked dial failure, end the loop with the verdict and never dial again",
    async (track) => {
      const classifyClose = (code) =>
        code === CLOSE_REVOKED
          ? { reason: "revoked", message: "device removed" }
          : null;

      const connection = fakeConnection("peer");
      const c = harness(track, {
        script: [() => Effect.succeed(connection)],
        classifyClose,
      });
      await c.start();
      c.lastDial().onClose(CLOSE_REVOKED);
      await settle();
      assert.deepEqual(c.statuses, [
        CONNECTING,
        connected("peer"),
        { phase: "blocked", reason: "revoked", message: "device removed" },
      ]);
      assert.deepEqual(c.connections, [connection, null]);
      await c.adjust(60 * 60_000);
      assert.equal(c.dials.length, 1, "a blocked supervisor redialed");
      assert.equal(c.statuses.length, 3);
      // Blocked is terminal: a second start() does not revive it.
      await c.start();
      assert.equal(c.dials.length, 1, "start() revived a blocked loop");

      // A blocked dial failure with no close code names itself in the
      // error: reason "refused" with the error's own message.
      const r = harness(track, {
        script: [
          () =>
            Effect.fail(new RemoteConnectError("hub refused: 401", null, true)),
        ],
        classifyClose,
      });
      await r.start();
      assert.deepEqual(r.statuses, [
        CONNECTING,
        { phase: "blocked", reason: "refused", message: "hub refused: 401" },
      ]);
      await r.adjust(60 * 60_000);
      assert.equal(r.dials.length, 1, "a refused supervisor redialed");
      assert.deepEqual(r.connections, []);

      // A blocked dial failure WITH a code goes through the classifier:
      // the default LAN rule reads a wrong token as "auth".
      const a = harness(track, {
        script: [
          () =>
            Effect.fail(
              new RemoteConnectError("closed 4001", CLOSE_AUTH_FAILED, true),
            ),
        ],
      });
      await a.start();
      assert.deepEqual(a.supervisor.status(), {
        phase: "blocked",
        reason: "auth",
        message: "authentication failed",
      });

      // The same code on a failure the transport did NOT tag blocked
      // retries: the transport's flag, not the code, decides a dial.
      const n = harness(track, {
        script: [
          () =>
            Effect.fail(
              new RemoteConnectError("closed 4001", CLOSE_AUTH_FAILED, false),
            ),
        ],
      });
      await n.start();
      assert.deepEqual(n.supervisor.status(), backoff(1, 1_000));
    },
  );

  await check(
    "stop: cancels a hanging dial, closes a held socket once, cuts a backoff short, marks a never-started supervisor stopped",
    async (track) => {
      // (a) A dial that never settles is interrupted.
      let interrupted = false;
      const hanging = harness(track, {
        script: [
          () =>
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
        ],
      });
      await hanging.start();
      assert.deepEqual(hanging.statuses, [CONNECTING]);
      await promptly(hanging.supervisor.stop(), "stop() during a dial");
      assert.equal(interrupted, true, "the hanging dial was not interrupted");
      assert.deepEqual(hanging.statuses, [CONNECTING, STOPPED]);
      assert.equal(
        hanging.connections.some((connection) => connection !== null),
        false,
      );
      await hanging.adjust(60 * 60_000);
      assert.equal(hanging.dials.length, 1, "a stopped supervisor redialed");

      // (b) A held connection is closed exactly once and reported lost.
      const connection = fakeConnection("peer");
      const held = harness(track, {
        script: [() => Effect.succeed(connection)],
      });
      await held.start();
      assert.deepEqual(held.connections, [connection]);
      await promptly(held.supervisor.stop(), "stop() while connected");
      assert.equal(connection.closes, 1);
      assert.deepEqual(held.connections, [connection, null]);
      assert.deepEqual(held.statuses, [CONNECTING, connected("peer"), STOPPED]);
      // A close callback landing after stop() moves nothing.
      held.lastDial().onClose(CLOSE_ABNORMAL);
      await held.adjust(60 * 60_000);
      assert.equal(held.dials.length, 1);
      assert.equal(held.statuses.length, 3);
      assert.equal(connection.closes, 1);

      // (c) A backoff sleep does not hold stop() up, and never wakes.
      const sleeping = harness(track, { script: [() => retryable()] });
      await sleeping.start();
      assert.deepEqual(sleeping.supervisor.status(), backoff(1, 1_000));
      await promptly(sleeping.supervisor.stop(), "stop() during backoff");
      assert.deepEqual(sleeping.statuses, [
        CONNECTING,
        backoff(1, 1_000),
        STOPPED,
      ]);
      await sleeping.adjust(60 * 60_000);
      assert.equal(sleeping.dials.length, 1, "a stopped backoff redialed");

      // (d) stop() before any start() still lands on stopped, once.
      const idle = harness(track, { script: [() => retryable()] });
      assert.deepEqual(idle.supervisor.status(), { phase: "idle" });
      await promptly(idle.supervisor.stop(), "stop() before start()");
      assert.deepEqual(idle.statuses, [STOPPED]);
      await idle.supervisor.stop();
      assert.deepEqual(idle.statuses, [STOPPED], "a second stop() re-fired");
      assert.equal(idle.dials.length, 0);
    },
  );

  await check(
    "onConnection: the connection on connect, null on its drop, the next one on the redial",
    async (track) => {
      const first = fakeConnection("peer");
      const second = fakeConnection("peer");
      const h = harness(track, {
        script: [() => Effect.succeed(first), () => Effect.succeed(second)],
      });
      await h.start();
      assert.deepEqual(h.connections, [first]);
      h.lastDial().onClose(CLOSE_ABNORMAL);
      await settle();
      assert.deepEqual(h.connections, [first, null]);
      assert.deepEqual(h.supervisor.status(), backoff(1, 1_000));
      await h.adjust(1_000);
      assert.deepEqual(h.connections, [first, null, second]);
      assert.deepEqual(h.statuses, [
        CONNECTING,
        connected("peer"),
        backoff(1, 1_000),
        CONNECTING,
        connected("peer"),
      ]);
      // Each dial got its own close callback: the first socket's late
      // callback does not drop the second.
      h.dials[0].onClose(CLOSE_ABNORMAL);
      await settle();
      assert.deepEqual(h.supervisor.status(), connected("peer"));
      assert.equal(h.connections.length, 3);
    },
  );

  await check(
    "start: a second start() is a no-op, and a start() after stop() begins at the bottom rung",
    async (track) => {
      const h = harness(track, { script: [() => retryable()] });
      h.supervisor.start();
      h.supervisor.start();
      await settle();
      assert.equal(h.dials.length, 1, "start() twice dialed twice");
      assert.deepEqual(h.statuses, [CONNECTING, backoff(1, 1_000)]);

      await h.adjust(1_000);
      assert.deepEqual(h.supervisor.status(), backoff(2, 2_000));
      await h.supervisor.stop();
      await h.start();
      assert.deepEqual(h.statuses.slice(-3), [
        STOPPED,
        CONNECTING,
        backoff(1, 1_000),
      ]);
      assert.equal(h.dials.length, 3);
    },
  );

  const elapsed = performance.now() - began;
  await check("no real time passes: the ladder ran on the TestClock", () => {
    assert.ok(elapsed < 1_000, `the proof took ${Math.round(elapsed)} ms`);
  });

  done();
}

main().catch(fail);
