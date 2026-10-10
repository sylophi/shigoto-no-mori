// A link to this machine's host: the device link's dialer
// (deviceLink.ts) on the loopback, with the loopback's token in place of
// a ticket. The desktop window dials it with the address its shell
// answers (window:hostAddress), and the shell with the one its host
// reported. A link that drops is dialed again, at the address answered
// then, so a host that went away (and came back on another port) is a
// reconnect: calls made meanwhile wait for it, and push subscriptions
// carry over. A view ends with the link it ran on.
import { LoopbackGroup } from "@shigomori/contracts/link";
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ClientTransport, Link } from "@shared/ipc/transport";
import { log } from "@shared/log";
import { dialDevice, type OpenClientSocket } from "./deviceLink";
import { linkTransport, pushFanOut } from "./rpcTransport";

// Where the host listens now, and the device it is (this machine's).
export type HostAddress = {
  readonly port: number;
  readonly token: string;
  readonly deviceId: string;
};

// How long one dial may take, and the waits between failed ones.
const DIAL_DEADLINE_MS = 10_000;
const REDIAL = Schedule.min([
  Schedule.exponential("100 millis", 2.5),
  Schedule.spaced("5 seconds"),
]);

export const hostLink = Effect.fnUntraced(function* (options: {
  // Asked again on every dial.
  readonly address: Effect.Effect<HostAddress, unknown>;
  readonly appVersion: string;
  readonly openSocket: OpenClientSocket;
}): Effect.fn.Return<
  Link & {
    // Drops the link and dials again: the shell's, when a host it forked
    // says it is up, since the one it had is gone with the last.
    readonly reconnect: Effect.Effect<void>;
  },
  never,
  Scope.Scope
> {
  const fanOut = pushFanOut();
  const current = yield* Ref.make(yield* Deferred.make<Link>());
  const reconnects = yield* Queue.sliding<void>(1);

  // One link at a time, each in a scope of its own, which closes as it
  // drops, as a reconnect is asked for, or as its dial fails.
  yield* Effect.gen(function* () {
    const { port, token, deviceId } = yield* options.address;
    const dialed = yield* dialDevice({
      url: `ws://127.0.0.1:${port}`,
      ticket: token,
      group: LoopbackGroup,
      appVersion: options.appVersion,
      localDeviceId: deviceId,
      expectedDeviceId: deviceId,
      openSocket: options.openSocket,
      deadlineMs: DIAL_DEADLINE_MS,
      onPush: fanOut.emit,
    });
    yield* Deferred.succeed(yield* Ref.get(current), dialed.link);
    yield* Effect.raceFirst(dialed.dropped, Queue.take(reconnects));
    yield* Ref.set(current, yield* Deferred.make<Link>());
  }).pipe(
    Effect.scoped,
    Effect.tapError((error) =>
      Effect.sync(() =>
        log.warn(
          `[host] could not reach this machine's host, dialing again: ${errorMessageOf(error)}`,
        ),
      ),
    ),
    Effect.retry(REDIAL),
    Effect.forever,
    Effect.forkScoped,
  );

  const up = Effect.flatMap(Ref.get(current), Deferred.await);
  return {
    // The host is this machine's own build, which decodes what it sends.
    local: true,
    call: (channel, input, span) =>
      Effect.flatMap(up, (link) => link.call(channel, input, span)),
    view: (channel, input) =>
      Stream.unwrap(Effect.map(up, (link) => link.view(channel, input))),
    pushes: fanOut.pushes,
    reconnect: Queue.offer(reconnects, undefined).pipe(Effect.asVoid),
  };
});

// The Promise face, for the shell, whose link lives as long as its
// process.
export function connectHost(options: {
  readonly address: () => Promise<HostAddress>;
  readonly appVersion: string;
  readonly openSocket: OpenClientSocket;
}): ClientTransport & { readonly reconnect: () => void } {
  return Effect.runSync(
    Effect.gen(function* () {
      const runFork = yield* FiberSet.makeRuntime<never>();
      const link = yield* hostLink({
        ...options,
        address: Effect.tryPromise(options.address),
      });
      return {
        ...linkTransport(link, runFork),
        reconnect: () => {
          runFork(link.reconnect);
        },
      };
    }).pipe(Scope.provide(Scope.makeUnsafe())),
  );
}
