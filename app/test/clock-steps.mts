// The remote links' timing against the clocks moving apart: the wall
// clock stepped two hours either way while monotonic time stands still
// (an NTP correction), a sleep as macOS has one (the wall clock runs
// on, monotonic time and every timer stand still, then a wake), and a
// stopped process (both clocks run on, no timer runs), on a TestClock
// (lib/checkKit.mts, `sleepingClock`). Covers the links' liveness
// (engine/liveness.ts), its one-shot question (`answerWithin`) and the
// hub socket's pings and wake probe on it (shared/hub/connection.ts), the
// supervisor's and the direct keeper's uptime (shared/remote/
// supervisor.ts, shared/hub/directKeeper.ts), and a window's renewal of
// a peer's attention after a failed ask (renderer/lib/remote/
// remoteSweep.ts).
import assert from "node:assert/strict";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { afterEach, it, vi } from "vitest";
import { NotSharingError } from "@shigomori/contracts/errors";
import {
  encodeEnvelope,
  HUB_PING,
  HUB_PONG,
} from "@shigomori/contracts/hubProtocol";
import {
  type HubSocketAdapter,
  make as makeHubConnection,
} from "@shared/hub/connection";
import { make as makeDirectKeeper } from "@shared/hub/directKeeper";
import {
  BACKOFF_LADDER_MS,
  STABLE_CONNECTION_MS,
  supervise,
  type SupervisorStatus,
} from "@shared/remote/supervisor";
import { answerWithin, watchLiveness } from "@shigomori/engine/liveness";
import { log } from "@shared/log";
import { makeSweepRenewals } from "@/lib/remote/remoteSweep";
import { entryAt, sleepingClock, testClock } from "./lib/checkKit.mts";
import { testDeviceKey } from "./lib/hubStub.mts";
import { trackTest } from "./lib/vitestKit.mts";

const HOUR = 3_600_000;

// A TestClock whose wall clock a sleep or a clock step moves alone,
// and a stop moves with monotonic time while no timer runs.
function clocks() {
  const clock = testClock();
  const moved = sleepingClock(clock);
  return {
    ...clock,
    context: Context.add(clock.context, Clock.Clock, moved.wall),
    now: () => moved.wall.currentTimeMillisUnsafe(),
    sleep: moved.sleep,
    stop: moved.stop,
  };
}

function madeOn<A>(
  context: Context.Context<never>,
  make: Effect.Effect<A, never, Scope.Scope>,
): A {
  const scope = Scope.makeUnsafe();
  trackTest(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return Effect.runSyncWith(context)(Scope.provide(scope)(make));
}

// The hub as the far end of an in-memory socket: it accepts with a
// roster, and answers a ping with a pong while `answering`. Each
// opened socket is one ticket.
function fakeHub() {
  const sockets: Array<{ closed: boolean }> = [];
  let answering = true;
  let deliver: ((text: string) => void) | undefined;
  const presence = encodeEnvelope({
    t: "presence",
    online: [{ deviceId: "A", publicKey: testDeviceKey("A").publicKey }],
  });
  const openSocket = (): HubSocketAdapter => {
    const socket = { closed: false };
    sockets.push(socket);
    let onMessage: ((text: string) => void) | undefined;
    let onClose: ((code: number) => void) | undefined;
    const end = () => {
      if (socket.closed) return;
      socket.closed = true;
      queueMicrotask(() => onClose?.(1006));
    };
    deliver = (text) => {
      if (!socket.closed) onMessage?.(text);
    };
    return {
      send: (text) => {
        if (socket.closed) throw new Error("closed");
        if (text === HUB_PING && answering)
          queueMicrotask(() => deliver?.(HUB_PONG));
      },
      close: end,
      terminate: end,
      onMessage: (handler) => {
        onMessage = handler;
        queueMicrotask(() => deliver?.(presence));
      },
      onClose: (handler) => {
        onClose = handler;
      },
    };
  };
  return {
    openSocket,
    tickets: () => sockets.length,
    setAnswering: (next: boolean) => {
      answering = next;
    },
  };
}

async function connectedHub() {
  const clock = clocks();
  const hub = fakeHub();
  const connection = madeOn(
    clock.context,
    makeHubConnection({ openSocket: hub.openSocket }),
  );
  await Effect.runPromiseWith(clock.context)(
    connection.refresh(
      Effect.succeed({
        hubUrl: "https://hub.test",
        accountId: "acct",
        mintTicket: async () => "ticket",
        deviceId: "A",
        deviceKey: testDeviceKey("A").privateKey,
      }),
    ),
  );
  await clock.settle();
  assert.equal(connection.status().socket.phase, "connected");
  return { clock, hub, connection };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("hub socket: the wall clock stepped two hours forward and back, with monotonic time still, neither cuts an answered socket nor spends a ticket", async () => {
  const { clock, hub, connection } = await connectedHub();
  for (const step of [2 * HOUR, -2 * HOUR, -2 * HOUR]) {
    // Each step lands while a ping is out.
    hub.setAnswering(false);
    await clock.advance(15_000);
    clock.sleep(step);
    hub.setAnswering(true);
    await clock.advance(60_000);
  }
  assert.equal(connection.status().socket.phase, "connected");
  assert.equal(hub.tickets(), 1);
});

it("hub socket: a ping that went unanswered into a sleep condemns nothing on its own; the wake's probe is a fresh observation, and a socket that fails it is redialed with the sleep in its log line", async () => {
  const { clock, hub, connection } = await connectedHub();
  const lines: string[] = [];
  vi.spyOn(log, "info").mockImplementation((...parts) => {
    lines.push(parts.join(" "));
  });
  // A ping goes out as the lid closes, and nothing answers it.
  hub.setAnswering(false);
  await clock.advance(15_000);
  // An hour asleep, then the beats after it, the hub answering: the
  // ping from before the sleep is overdue only in awake time, and then
  // asked again rather than judged.
  clock.sleep(HOUR);
  hub.setAnswering(true);
  await clock.advance(60_000);
  assert.equal(connection.status().socket.phase, "connected");
  assert.equal(hub.tickets(), 1);

  // Asleep again, and this time the socket died with it.
  hub.setAnswering(false);
  clock.sleep(HOUR);
  connection.probe();
  await clock.advance(4_000);
  assert.equal(
    connection.status().socket.phase,
    "connected",
    "before its window",
  );
  hub.setAnswering(true);
  await clock.advance(1_000 + BACKOFF_LADDER_MS[0]);
  assert.equal(hub.tickets(), 2, "redialed after the failed probe");
  assert.ok(
    lines.some((line) => line.includes("woke after 60 min")),
    lines.join("\n"),
  );
  assert.equal(connection.status().socket.phase, "connected");
});

it("liveness: a probe set aside by a late turn is interrupted, so a hidden page's minute-late turns against a peer that never answers leave one ping out, not one per turn", async () => {
  const clock = clocks();
  let out = 0;
  let most = 0;
  let deaths = 0;
  madeOn(
    clock.context,
    watchLiveness({
      ping: Effect.acquireUseRelease(
        Effect.sync(() => {
          out += 1;
          most = Math.max(most, out);
        }),
        () => Effect.never,
        () =>
          Effect.sync(() => {
            out -= 1;
          }),
      ),
      heard: () => 0,
      intervalMs: 15_000,
      timeoutMs: 40_000,
      probeTimeoutMs: 5_000,
      dead: Effect.sync(() => {
        deaths += 1;
      }),
    }),
  );
  // Ten minutes of a throttled page: whatever a timer asked for, it
  // runs about a minute late.
  for (let turn = 0; turn < 120; turn++) {
    clock.stop(55_000);
    await clock.advance(5_000);
  }
  assert.equal(most, 1, "probes piled up");
  assert.equal(deaths, 0, "judged on a turn it had no time to hear in");
  // Its turns on time again, the silent peer is found.
  await clock.advance(45_000);
  assert.equal(deaths, 1, "the silent peer was never judged");
});

it("liveness: one question whose limit came late, by a stop or a sleep, is asked again rather than answered none, and silence through a limit this end ran is none", async () => {
  const clock = clocks();
  const asks = (onTime: () => void) => {
    let asked = 0;
    // The answer waits unread until the question is asked again.
    const ask = Effect.suspend(() =>
      ++asked === 1
        ? Effect.sync(onTime).pipe(Effect.andThen(Effect.never))
        : Effect.succeed("here"),
    );
    return Effect.runPromiseWith(clock.context)(answerWithin(ask, 10_000));
  };
  for (const pause of [clock.stop, clock.sleep]) {
    const answered = asks(() => pause(60_000));
    await clock.advance(10_000);
    const answer = await answered;
    assert.ok(Option.isSome(answer) && Exit.isSuccess(answer.value));
  }
  const silent = Effect.runPromiseWith(clock.context)(
    answerWithin(Effect.never, 10_000),
  );
  await clock.advance(10_000);
  assert.ok(Option.isNone(await silent));
});

function flapping() {
  const clock = clocks();
  const statuses: SupervisorStatus[] = [];
  let connects = 0;
  let close: ((code: number | null) => void) | undefined;
  madeOn(
    clock.context,
    supervise({
      classifyClose: () => null,
      connect: (onClose) => {
        connects += 1;
        close = onClose;
        return Effect.succeed({
          probe: () => {},
        });
      },
      onStatus: (status) => statuses.push(status),
    }),
  );
  return {
    clock,
    connects: () => connects,
    drop: () => close?.(null),
    lastDelay: () => {
      const status = statuses.findLast((s) => s.phase === "backoff");
      return status?.phase === "backoff" ? status.delayMs : null;
    },
  };
}

it("supervisor: uptime is monotonic, so neither a sleep nor a forward step makes a short connection stable, and a backward step keeps a healthy one from looking short", async () => {
  const s = flapping();
  await s.clock.settle();
  // A connection that drops at once climbs the ladder.
  s.drop();
  await s.clock.settle();
  assert.equal(s.lastDelay(), BACKOFF_LADDER_MS[0]);
  await s.clock.advance(BACKOFF_LADDER_MS[0]);
  assert.equal(s.connects(), 2);

  // Up 5 s, then an hour asleep, and a drop 5 s after the wake.
  await s.clock.advance(5_000);
  s.clock.sleep(HOUR);
  await s.clock.advance(5_000);
  s.drop();
  await s.clock.settle();
  assert.equal(
    s.lastDelay(),
    entryAt(BACKOFF_LADDER_MS, 1),
    "the sleep was no uptime",
  );
  await s.clock.advance(entryAt(BACKOFF_LADDER_MS, 1));

  // Up 5 s across a two-hour forward step.
  await s.clock.advance(2_500);
  s.clock.sleep(2 * HOUR);
  await s.clock.advance(2_500);
  s.drop();
  await s.clock.settle();
  assert.equal(
    s.lastDelay(),
    entryAt(BACKOFF_LADDER_MS, 2),
    "the step was no uptime",
  );
  await s.clock.advance(entryAt(BACKOFF_LADDER_MS, 2));

  // Up past the stable threshold across a two-hour backward step.
  s.clock.sleep(-2 * HOUR);
  await s.clock.advance(STABLE_CONNECTION_MS);
  s.drop();
  await s.clock.settle();
  assert.equal(s.lastDelay(), BACKOFF_LADDER_MS[0], "a stable run resets");
});

it("direct keeper: a session's uptime is monotonic, so a sleep makes no short session stable, as the supervisor's", async () => {
  const clock = clocks();
  const dials: number[] = [];
  const keeper = madeOn(
    clock.context,
    makeDirectKeeper({
      dial: () =>
        Effect.sync(() => {
          dials.push(clock.now());
        }),
    }),
  );
  keeper.reconcile(["B"]);
  await clock.settle();
  assert.equal(dials.length, 1);
  // Two short sessions (one across a sleep), each dropped.
  for (let round = 0; round < 2; round += 1) {
    await clock.advance(5_000);
    if (round === 1) {
      clock.sleep(HOUR);
      await clock.advance(5_000);
    }
    keeper.peerDropped("B");
    await clock.settle();
    await clock.advance(entryAt(BACKOFF_LADDER_MS, round) - 1);
    assert.equal(
      dials.length,
      round + 1,
      `round ${round}: not before its rung`,
    );
    await clock.advance(1);
    assert.equal(dials.length, round + 2, `round ${round}: on its rung`);
  }
});

it("renewal: a failed ask while the session stays up is asked again at the next renewal, a refusal parks until a landing, and an unfocused window asks nothing", async () => {
  vi.useFakeTimers();
  const asks: boolean[] = [];
  let fail = false;
  let refusal = false;
  const renewals = makeSweepRenewals(
    {
      sweep: (_deviceId, renewal) => {
        asks.push(renewal);
        if (refusal) {
          return Promise.reject(new NotSharingError({}));
        }
        return fail
          ? Promise.reject(new Error("timed out"))
          : Promise.resolve({ leaseMs: 60_000 });
      },
      connected: () => true,
    },
    true,
  );
  trackTest(() => renewals.stop());
  renewals.landed("B");
  await vi.advanceTimersByTimeAsync(30_000);
  assert.deepEqual(asks, [false, true]);

  // The next renewal fails: asked again a renewal later, and carrying on.
  fail = true;
  await vi.advanceTimersByTimeAsync(30_000);
  fail = false;
  await vi.advanceTimersByTimeAsync(30_000 - 1);
  assert.equal(asks.length, 3, "not before the next renewal");
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(30_000);
  assert.deepEqual(asks, [false, true, true, true, true]);

  // A refusal is the peer's answer: nothing asks again until a landing.
  refusal = true;
  await vi.advanceTimersByTimeAsync(30_000);
  const refused = asks.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  assert.equal(asks.length, refused, "a refusal parks");
  refusal = false;
  renewals.landed("B");
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(asks.length, refused + 1);

  // Unfocused, nothing is asked again or renewed.
  fail = true;
  await vi.advanceTimersByTimeAsync(30_000);
  renewals.attend(false, []);
  const count = asks.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  assert.equal(asks.length, count);
});
