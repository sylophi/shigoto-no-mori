// Client half of the direct data plane: dial a
// peer's direct listener, brokered over the device hub. The dialer asks
// the peer for its connect info (the hub link's one ask, a single round
// trip), then dials the returned candidates, each a complete URL
// (ws:// interface candidates, the wss:// tunnel endpoint) with its own
// single-use ticket. The result is the SAME DeviceConnection shape the
// LAN client resolves, so everything downstream (the bridge cache,
// sync, port-forward) stays transport agnostic.
//
// DIAL STRATEGY: a deadline for each of the attempt's two legs, the
// ask and then the candidate race, so a wedged peer that never answers
// cannot hold the bridge's dial forever, and an answer that
// came late (a peer just woken) leaves the race its whole budget: a
// handshake across the tunnel after a slow answer used to run out and
// win on the next rung instead. All candidate SOCKETS open concurrently, each sealed with its own ticket
// to the key the hub's roster names for the peer (shared/remote/
// sealedSocket.ts), so whoever answers a candidate address, only the
// peer completes the handshake. The HELLOS are serialized:
// at most one hello is in flight, the next candidate's hello goes out
// only after the previous handshake failed, and losers whose hello
// was never sent are closed pre-auth. Serialization is what makes a
// multi-candidate dial safe against the host's
// one-authed-socket-per-device supersede rule: with concurrent hellos
// the SLOWER candidate's hello would land after the winner was cached
// and supersede-kill the fresh session, so the first invoke on it
// would reject. An abandoned pre-auth socket costs the host only its
// own candidate's ticket and supersedes nothing, so a junk candidate
// opening first (Docker bridges, VPN interfaces) costs only its own
// open, never the race.
//
// BLOCKED VERDICTS: what makes a verdict terminal is the host's answer,
// because this side has no other honest source. The host refuses a bad
// ticket or key by closing the handshake with its own code (read as
// LinkRefusedError, blocked) and closes on a locked-out client before
// it (retryable), and only the host can tell those apart: the lockout keys on client IP, and benches whoever
// dials next even with a perfect ticket.
//
// A blocked verdict is terminal, but it does NOT end the race: a
// refusing far end has proved nothing, and a LAN address may be held by
// a squatter, which must not deny a dial the tunnel can still win. The refusal is remembered and decides the attempt only if
// no candidate wins (at exhaustion or at the deadline).
//
// STRUCTURAL VERDICTS: two answers to the ask are facts about the peer
// rather than failed calls, so they reject typed and terminal
// (isTerminalDialError) instead of as the plain refusal they arrive
// as, or eager supervision would redial them on the ladder's cap
// forever:
//
//   - the peer serves no direct listener (a web client, by
//     construction), answered with NO_LISTENER_CODE.
//
// Every other failure of the ask (hub blip, peer mid-boot, timeout, a
// refusal carrying a plain message, a peer speaking another shape of
// the wire and so never answering) stays transient.
//
// ONE ATTEMPT, NO POLICY: connectDirect is a single dial under a
// single deadline, and a failure rejects typed with no retry and no
// memo. Retry lives in exactly one place, the presence-driven keeper
// (shared/hub/directKeeper.ts), which paces redials on the shared
// backoff ladder and parks on the terminal verdicts
// (isTerminalDialError below). Data is direct or nothing: there is no
// hub fallback behind these failures, the typed rejection IS the
// outcome the caller surfaces. A second retry owner here would fight
// the keeper's ladder, so this file deliberately carries none.
//
// Pure browser-global-plus-shared code: no node builtins, no electron,
// so the direct-plane check drives it headlessly under node (whose
// global WebSocket serves dialDevice).
import type { KeyPair } from "@shared/crypto/noise";
import type { DeviceKind } from "@shigomori/contracts/modules/link";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  ALL_DIRECT_CANDIDATE_KINDS,
  type DirectCandidate,
  type DirectCandidateKind,
  type DirectConnectInfoInput,
  DirectConnectInfoSchema,
} from "@shigomori/contracts/modules/direct";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  type DialedDevice,
  dialDevice,
  type OpenClientSocket,
  RemoteConnectError,
} from "@shared/remote/deviceLink";
import { newConnectionId } from "@shigomori/engine/rpcClient";
import { HELLO_TIMEOUT_MS } from "@shared/remote/link";
import { HubAskRefusedError, NO_LISTENER_CODE } from "./link";

// The DeviceConnection shape, so everything downstream of a direct
// dial (the bridge cache, sync, port-forward) is transport agnostic,
// plus the two facts the connectInfo answer carried beside the
// candidates: whether the peer runs this device's commands, and
// whether it shares with this device at all. The bridge keeps them
// current from the peer's commandAccessChanged and sharing:changed
// pushes.
export type PeerConnection = Omit<DialedDevice, "link"> & {
  acceptsCommands: boolean;
  sharesData: boolean;
};

// The peer serves no direct listener (a web client), so there is
// nothing to dial and never will be while it is that platform. Typed so
// a caller can tell "there is nothing here to dial" apart from an
// ordinary dial failure, and worded for the keeper, which surfaces the
// message as the peer's unavailable reason.
export class NoDialableCandidateError extends Data.TaggedError(
  "NoDialableCandidateError",
)<{ readonly message: string }> {
  constructor(deviceId: string) {
    super({ message: `peer ${deviceId} serves no direct listener` });
  }
}

// A dial that failed short of a refusal: the ask went unanswered, its
// answer offered nothing to dial, or the race ran out of budget.
// Transient, so the keeper keeps it on the ladder; the message is what
// it logs and the bridge's no-session rejection says.
class DirectDialError extends Data.TaggedError("DirectDialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// True when redialing at once cannot change the outcome: a blocked
// verdict (a ticket the host read and refused, or the wrong machine
// answered) or a peer with no direct listener. The keeper parks on the
// second, and asks again after the first only on its slow refusal
// ladder, which keeps eager supervision from feeding the host's
// per-identity failed-auth lockout a steady diet of refused tickets.
// Every other failure (unreachable, deadline, no listener yet) is
// transient and retries forever on the shared ladder.
export function isTerminalDialError(error: unknown): boolean {
  return (
    (error instanceof RemoteConnectError && error.blocked) ||
    error instanceof NoDialableCandidateError
  );
}

export type DirectDialerDeps = {
  // Asks the peer for its connect info over the device hub (the hub
  // link's one ask), rejecting within timeoutMs. The whole reach this
  // dialer has into the device hub, so it cannot move contract traffic
  // there even by accident.
  askConnectInfo(
    deviceId: string,
    input: DirectConnectInfoInput,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  // This device's identity, carried in the direct hello.
  localDeviceId: string;
  // What a link's sealed socket is made of (shared/remote/sealedSocket.ts):
  // this device's key pair, and the key the hub's roster names for the
  // peer. Read at each dial, so a key enrolled since is the one used.
  localKey(): KeyPair | null;
  peerKey(deviceId: string): Uint8Array | undefined;
  localAppVersion: string;
  // Every push received on a direct connection, tagged with the peer's
  // deviceId, so the owner can feed the same peerPush path the device
  // hub feeds.
  onAnyPush?: (deviceId: string, channel: string, payload: unknown) => void;
  // The candidate kinds THIS platform can dial, declared to the host
  // in the connectInfo input so it only mints tickets this caller can
  // spend. The web bridge declares ["tunnel"] (a browser page cannot
  // dial ws:// under https, mixed content), the app takes the default
  // and races everything.
  dialableKinds?: ReadonlyArray<DirectCandidateKind>;
  // What this device is: a web client holds a link per tab to a host,
  // a desktop app one (deviceLink.ts).
  deviceKind?: DeviceKind;
  // The candidate sockets' constructor, defaulting to the platform
  // global WebSocket. The host injects the `ws`
  // package so a failed candidate names its errno instead of a bare
  // 1006 (see OpenClientSocket in shared/remote/deviceLink.ts).
  openSocket?: OpenClientSocket;
  // Test seam. Real callers take the default.
  deadlineMs?: number;
};

export type DirectDialer = {
  // The link, up in the caller's scope until it closes or the link
  // drops (`dropped`). Interrupted, every candidate's socket closes.
  connectDirect(
    deviceId: string,
  ): Effect.Effect<PeerConnection, unknown, Scope.Scope>;
};

type CandidateFailure = { candidate: DirectCandidate; error: unknown };

const openGlobalSocket: OpenClientSocket = (url) => new WebSocket(url);

// The exhaustion reject: every candidate retired and none refused its
// ticket. Its message names EVERY candidate and how it
// died, because the last candidate's error alone ("closed before
// welcome (code 1006)") says nothing about which address was even
// tried, and on a platform whose WebSocket reports no cause a refused
// port, an unroutable address and a permission block all produce
// exactly that line. Grouped by reason so six interface addresses
// dying the same way read as one clause. The hints name the two facts
// a user can act on: a peer that advertised no tunnel (no tunnel
// candidate among the retired ones) is reachable from its own network
// only, and EHOSTUNREACH on a LAN address is macOS refusing the app
// Local Network access far more often than a routing problem, unless
// the machines are on different networks, which this end cannot tell,
// so that hint names the addresses tried and the tunnel's failure.
//
// Still a RemoteConnectError carrying the last candidate's close code,
// and never blocked: a blocked failure is the attempt's refusal and
// rejects in its place (see BLOCKED VERDICTS in the header).
function exhaustionError(
  deviceId: string,
  failures: readonly CandidateFailure[],
): RemoteConnectError {
  const byReason = new Map<string, string[]>();
  for (const { candidate, error } of failures) {
    const reason = errorMessageOf(error);
    const urls = byReason.get(reason) ?? [];
    urls.push(`${candidate.kind} ${candidate.url}`);
    byReason.set(reason, urls);
  }
  // Sorted so the text does not depend on retirement order (a race
  // outcome): the keeper logs a failure only when its text changes.
  const attempts = [...byReason]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([reason, urls]) => `${urls.join(", ")}: ${reason}`)
    .join(". ");
  const hints: string[] = [];
  if (!failures.some(({ candidate }) => candidate.kind === "tunnel")) {
    hints.push(
      "The peer offered no tunnel endpoint, so it can only be reached from its own local network.",
    );
  }
  const unroutable = failures.filter(
    ({ candidate, error }) =>
      candidate.kind === "lan" &&
      errorMessageOf(error).includes("EHOSTUNREACH"),
  );
  if (unroutable.length > 0) {
    const lan = unroutable
      .map(({ candidate }) => candidate.url)
      .toSorted()
      .join(", ");
    // Machines on different networks fail every LAN address this way
    // too, and there the tunnel is the path that mattered.
    const tunnel = failures.find(
      ({ candidate }) => candidate.kind === "tunnel",
    );
    hints.push(
      `No route to ${lan}: if both machines share a network, macOS may be denying this app Local Network access (System Settings > Privacy & Security > Local Network).` +
        (tunnel === undefined
          ? ""
          : ` If they don't, the tunnel was the path, and it failed: ${errorMessageOf(tunnel.error)}.`),
    );
  }
  const last = failures[failures.length - 1]?.error;
  return new RemoteConnectError(
    `could not reach peer ${deviceId} on any candidate (${attempts})` +
      (hints.length === 0 ? "" : `. ${hints.join(" ")}`),
    last instanceof RemoteConnectError ? last.code : null,
    false,
  );
}

export function createDirectDialer(deps: DirectDialerDeps): DirectDialer {
  // Each leg's deadline (the ask, then the race). HELLO_TIMEOUT_MS is
  // the wire's one honest "a handshake should have happened by now"
  // value.
  const deadlineMs = deps.deadlineMs ?? HELLO_TIMEOUT_MS;
  const dialableKinds = [...(deps.dialableKinds ?? ALL_DIRECT_CANDIDATE_KINDS)];

  // Open every candidate's socket at once, then hello them one at a
  // time in socket-open order (see the file header for why hellos are
  // serialized). The first successful handshake wins and stays up in
  // the caller's scope; every other socket is closed pre-auth. Out of
  // budget, the race fails with the remembered refusal, or the deadline.
  const raceCandidates = (
    deviceId: string,
    candidates: readonly DirectCandidate[],
    budgetMs: number,
    seal: { readonly localKey: KeyPair; readonly remoteKey: Uint8Array },
    connectionId: string,
  ): Effect.Effect<DialedDevice, unknown, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      let winner: number | null = null;
      // Each candidate's link, up until its fiber is interrupted: the
      // losers' at the race's end, the winner's with the caller's scope.
      const dials = yield* Effect.forEach(candidates, (candidate, index) =>
        Effect.gen(function* () {
          const opened = yield* Deferred.make<void, RemoteConnectError>();
          const helloAsked = yield* Deferred.make<void>();
          const welcomed = yield* Deferred.make<
            DialedDevice,
            RemoteConnectError
          >();
          const fiber = yield* dialDevice(
            {
              url: candidate.url,
              openSocket: deps.openSocket ?? openGlobalSocket,
              // This candidate's own single-use ticket, which opens its
              // socket, sealed to the key the roster names for the peer:
              // whoever answers a candidate address, only the peer can
              // complete the handshake.
              ticket: candidate.ticket,
              seal,
              connectionId,
              appVersion: deps.localAppVersion,
              localDeviceId: deps.localDeviceId,
              deviceKind: deps.deviceKind,
              // Identity pin: a welcome from any other deviceId fails
              // the handshake and closes the socket.
              expectedDeviceId: deviceId,
              onPush: (channel, payload) => {
                if (winner === index) {
                  deps.onAnyPush?.(deviceId, channel, payload);
                }
              },
              deadlineMs: budgetMs,
            },
            { opened, helloAsked },
          ).pipe(
            Effect.flatMap((dialed) =>
              Effect.andThen(Deferred.succeed(welcomed, dialed), Effect.never),
            ),
            Effect.scoped,
            // Settled however it ends short of an interrupt, a defect of
            // an injected socket's included, so the race never waits out
            // its deadline on a candidate that is gone.
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause))
                return Effect.failCause(cause);
              const error = Cause.squash(cause);
              const failed =
                error instanceof RemoteConnectError
                  ? error
                  : new RemoteConnectError(errorMessageOf(error), null, false);
              return Effect.andThen(
                Deferred.fail(opened, failed),
                Deferred.fail(welcomed, failed),
              );
            }),
            Effect.forkIn(scope),
          );
          return { candidate, index, opened, helloAsked, welcomed, fiber };
        }),
      );
      const losersClosed = Effect.forEach(
        dials,
        ({ index, fiber }) =>
          index === winner ? Effect.void : Fiber.interrupt(fiber),
        { discard: true },
      );

      // Every retired candidate with its error, in retirement order,
      // for the exhaustion failure's per-candidate summary, and the
      // first refusal, which decides the attempt only if no candidate
      // wins.
      const failures: CandidateFailure[] = [];
      let refusal: RemoteConnectError | null = null;
      const retire = (candidate: DirectCandidate, error: unknown) => {
        if (error instanceof RemoteConnectError && error.blocked) {
          // The ticket was refused, or the wrong machine answered.
          // Terminal, but only once the race is over: the far end
          // proved nothing, and on a LAN address it may be a squatter,
          // which must not deny a dial another candidate can win.
          refusal ??= error;
        }
        failures.push({ candidate, error });
      };

      const hellos = Effect.gen(function* () {
        // The candidates in the order their sockets open or fail.
        const opens = yield* Queue.unbounded<{
          readonly dial: (typeof dials)[number];
          readonly exit: Exit.Exit<void, RemoteConnectError>;
        }>();
        yield* Effect.forEach(
          dials,
          (dial) =>
            Deferred.await(dial.opened).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Queue.offer(opens, { dial, exit })),
              Effect.forkScoped,
            ),
          { discard: true },
        );
        for (let retired = 0; retired < dials.length; retired += 1) {
          const { dial, exit } = yield* Queue.take(opens);
          if (Exit.isFailure(exit)) {
            retire(dial.candidate, Cause.squash(exit.cause));
            continue;
          }
          yield* Deferred.succeed(dial.helloAsked, undefined);
          const welcomed = yield* Effect.exit(Deferred.await(dial.welcomed));
          if (Exit.isSuccess(welcomed)) {
            winner = dial.index;
            return welcomed.value;
          }
          retire(dial.candidate, Cause.squash(welcomed.cause));
        }
        return yield* Effect.fail(
          refusal ?? exhaustionError(deviceId, failures),
        );
      });

      return yield* hellos.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: budgetMs,
          orElse: () =>
            Effect.fail(
              refusal ??
                new DirectDialError({
                  message: `direct dial to ${deviceId} exceeded its ${deadlineMs}ms deadline`,
                }),
            ),
        }),
        Effect.ensuring(losersClosed),
      );
    });

  // One whole attempt, each leg under its deadline.
  const connectDirect = (deviceId: string) =>
    Effect.gen(function* () {
      // This dial's connection: its tickets are minted for it, and its
      // hello names it.
      const connectionId = newConnectionId();
      // The input declares this platform's dialable kinds so the host
      // mints no ticket we cannot spend.
      const answer = yield* Effect.tryPromise({
        try: (signal) =>
          deps.askConnectInfo(
            deviceId,
            { dialableKinds, connectionId },
            deadlineMs,
            signal,
          ),
        // No direct listener to advertise (a web client), not a call
        // that failed. Terminal, so the keeper parks it until the
        // peer's roster round trip. Every other failure is transient.
        catch: (error) =>
          error instanceof HubAskRefusedError && error.code === NO_LISTENER_CODE
            ? new NoDialableCandidateError(deviceId)
            : new DirectDialError({
                message: errorMessageOf(error),
                cause: error,
              }),
      });
      const info = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(DirectConnectInfoSchema)(answer),
        catch: (error) =>
          new DirectDialError({
            message: `peer ${deviceId} answered no connect info this build reads`,
            cause: error,
          }),
      });
      if (!info.available) {
        // The peer's listener is down, or it has nothing THIS caller
        // can dial. Unreachable for data RIGHT NOW, which is not the
        // same as structurally undialable: its listener may be
        // mid-boot, or the directConnections opt-out may be flipped back
        // on without any roster transition to unpark on. So this stays
        // a plain, transient error and the keeper keeps it on the ladder.
        return yield* new DirectDialError({
          message: `peer ${deviceId} offers no direct listener`,
        });
      }
      const localKey = deps.localKey();
      const remoteKey = deps.peerKey(deviceId);
      if (localKey === null || remoteKey === undefined) {
        return yield* new DirectDialError({
          message: `peer ${deviceId} has no key on the roster`,
        });
      }
      const { link: _, ...dialed } = yield* raceCandidates(
        deviceId,
        info.candidates,
        deadlineMs,
        { localKey, remoteKey },
        connectionId,
      );
      return {
        ...dialed,
        acceptsCommands: info.acceptsCommands,
        sharesData: info.sharesData,
      } satisfies PeerConnection;
    });

  return { connectDirect };
}
