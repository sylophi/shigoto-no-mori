// Client half of the direct data plane: dial a
// peer's direct listener, brokered over the device hub. The dialer asks
// the peer for its connect info (the hub link's one ask, a single round
// trip), then dials the returned candidates, each a complete URL
// (ws:// interface candidates, the wss:// tunnel endpoint) with its own
// single-use ticket. The result is the SAME DeviceConnection shape the
// LAN client resolves, so everything downstream (the bridge cache,
// sync, port-forward) stays transport agnostic.
//
// DIAL STRATEGY: one overall deadline around the WHOLE attempt (the ask
// included: it gets the deadline as its timeout, so a wedged peer that
// never answers cannot hang the bridge's cached promise forever). All
// candidate SOCKETS open concurrently, each sealed with its own ticket
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
// global WebSocket serves openDevice).
import type { KeyPair } from "@shared/crypto/noise";
import type { DeviceKind } from "@shigomori/contracts/modules/link";
import * as Schema from "effect/Schema";
import {
  ALL_DIRECT_CANDIDATE_KINDS,
  MAX_DIRECT_CANDIDATES,
  type DirectCandidate,
  type DirectCandidateKind,
  type DirectConnectInfoInput,
  DirectConnectInfoSchema,
} from "@shigomori/contracts/modules/direct";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  newConnectionId,
  openDevice,
  type OpenClientSocket,
  RemoteConnectError,
  type DeviceConnection,
  type PendingDeviceConnection,
} from "@shared/remote/deviceLink";
import { HELLO_TIMEOUT_MS } from "@shared/remote/link";
import { HubAskRefusedError, NO_LISTENER_CODE } from "./link";

// The DeviceConnection shape, so everything downstream of a direct
// dial (the bridge cache, sync, port-forward) is transport agnostic,
// plus the two facts the connectInfo answer carried beside the
// candidates: whether the peer runs this device's commands, and
// whether it shares with this device at all. The bridge keeps them
// current from the peer's commandAccessChanged and sharing:changed
// pushes.
export type PeerConnection = DeviceConnection & {
  acceptsCommands: boolean;
  sharesData: boolean;
};

export type ConnectPeerOpts = {
  // Called once when an ESTABLISHED direct connection dies on its own
  // (socket teardown, roster drop). Never fires for an owner initiated
  // close, and never for a failed connect.
  onClose?: () => void;
};

// Candidates dialed at once: the shared advertising cap for interface
// addresses plus the one tunnel candidate, enforced here too so a
// hostile or buggy connectInfo answer cannot fan out an unbounded dial
// burst.
const MAX_DIAL_CANDIDATES = MAX_DIRECT_CANDIDATES + 1;

// The peer serves no direct listener (a web client), so there is
// nothing to dial and never will be while it is that platform. Typed so
// a caller can tell "there is nothing here to dial" apart from an
// ordinary dial failure, and worded for the keeper, which surfaces the
// message as the peer's unavailable reason.
export class NoDialableCandidateError extends Error {
  constructor(deviceId: string) {
    super(`peer ${deviceId} serves no direct listener`);
    this.name = "NoDialableCandidateError";
  }
}

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
  // global WebSocket. The Electron main process injects the `ws`
  // package so a failed candidate names its errno instead of a bare
  // 1006 (see OpenClientSocket in shared/remote/deviceLink.ts).
  openSocket?: OpenClientSocket;
  // Test seams. Real callers take the defaults and real time.
  deadlineMs?: number;
  now?: () => number;
};

export type DirectDialer = {
  connectDirect(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection>;
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
// Local Network access far more often than a routing problem.
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
  if (
    failures.some(
      ({ candidate, error }) =>
        candidate.kind === "lan" &&
        errorMessageOf(error).includes("EHOSTUNREACH"),
    )
  ) {
    hints.push(
      "No route to host: if both machines share a network, macOS may be denying this app Local Network access (System Settings > Privacy & Security > Local Network).",
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
  // The overall attempt deadline. HELLO_TIMEOUT_MS is the wire's one
  // honest "a handshake should have happened by now" value, and each
  // leg below (the ask, every candidate handshake) individually stays
  // under it.
  const deadlineMs = deps.deadlineMs ?? HELLO_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const dialableKinds = [...(deps.dialableKinds ?? ALL_DIRECT_CANDIDATE_KINDS)];

  // Open every candidate's socket at once, then hello them one at a
  // time in socket-open order (see the file header for why hellos are
  // serialized). The first successful handshake wins and every other
  // socket is abandoned pre-auth. The race rejects when what is left
  // of the attempt's budget (remainingMs) runs out, and a handshake that
  // resolves after settlement is closed rather than leaked.
  function raceCandidates(
    deviceId: string,
    opts: ConnectPeerOpts | undefined,
    candidates: DirectCandidate[],
    remainingMs: number,
    seal: { readonly localKey: KeyPair; readonly remoteKey: Uint8Array },
    connectionId: string,
  ): Promise<DeviceConnection> {
    return new Promise<DeviceConnection>((resolvePromise, rejectPromise) => {
      let done = false;
      // Out of budget: the remembered refusal if there is one, else the
      // deadline itself.
      const deadlineTimer = setTimeout(() => {
        if (done) return;
        done = true;
        settleAll();
        reject(
          refusal ??
            new Error(
              `direct dial to ${deviceId} exceeded its ${deadlineMs}ms deadline`,
            ),
        );
      }, remainingMs);
      // Every settlement clears the deadline timer, so a settled race
      // leaves nothing armed.
      const resolve = (connection: DeviceConnection): void => {
        clearTimeout(deadlineTimer);
        resolvePromise(connection);
      };
      const reject = (error: unknown): void => {
        clearTimeout(deadlineTimer);
        rejectPromise(error);
      };
      let winnerIndex = -1;
      let outstanding = candidates.length;
      // Every retired candidate with its error, in retirement order,
      // for the exhaustion reject's per-candidate summary.
      const failures: CandidateFailure[] = [];
      // Indexes whose socket is open and whose hello is queued behind
      // the one in flight. Null helloIndex means the pump may send the
      // next hello.
      const ready: number[] = [];
      let helloIndex: number | null = null;
      // The first refusal, which decides the attempt only if no
      // candidate wins.
      let refusal: RemoteConnectError | null = null;

      const handles: PendingDeviceConnection[] = candidates.map(
        (candidate, index) =>
          openDevice({
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
            // Only the winning candidate's lifecycle belongs to the
            // caller: a losing or abandoned socket dropping must not
            // evict the winner from the bridge cache.
            onClose: () => {
              if (winnerIndex === index) opts?.onClose?.();
            },
            onPush: (channel, payload) => {
              if (winnerIndex === index) {
                deps.onAnyPush?.(deviceId, channel, payload);
              }
            },
            // The open is bounded by what is left of the attempt, and the
            // race's deadline abandons whatever is still waiting.
            deadlineMs: remainingMs,
          }),
      );

      const settleAll = (): void => {
        for (const handle of handles) handle.abandon();
      };

      // One settlement per candidate: either its whenOpen rejected
      // (never queued) or its authenticate rejected (its hello turn
      // failed, or its socket died while queued).
      const failCandidate = (index: number, error: unknown): void => {
        if (done) return;
        if (error instanceof RemoteConnectError && error.blocked) {
          // The ticket was refused, or the wrong machine answered.
          // Terminal, but only once the race is over: the far end
          // proved nothing, and on a LAN address it may be a squatter,
          // which must not deny a dial another candidate can win.
          // `blocked` is the host's close code, which tells a refused
          // credential from its temporary lockout.
          refusal ??= error;
        }
        const candidate = candidates[index];
        if (candidate !== undefined) failures.push({ candidate, error });
        outstanding -= 1;
        if (outstanding === 0) {
          done = true;
          reject(refusal ?? exhaustionError(deviceId, failures));
        }
      };

      const pump = (): void => {
        if (done || helloIndex !== null) return;
        const index = ready.shift();
        if (index === undefined) return;
        const handle = handles[index];
        if (handle === undefined) {
          // Not reachable (ready holds indexes of handles), but a
          // silent return here would stall the race to its deadline.
          failCandidate(index, new Error("a ready candidate has no handle"));
          pump();
          return;
        }
        helloIndex = index;
        handle.authenticate().then(
          (connection) => {
            if (done) {
              connection.close();
              return;
            }
            done = true;
            winnerIndex = index;
            // The losers never sent a hello (serialization), so the
            // abandon is a pre-auth close the host never even logs.
            handles.forEach((other, i) => {
              if (i !== index) other.abandon();
            });
            resolve(connection);
          },
          (error: unknown) => {
            helloIndex = null;
            failCandidate(index, error);
            pump();
          },
        );
      };

      handles.forEach((handle, index) => {
        handle.whenOpen.then(
          () => {
            if (done) return;
            ready.push(index);
            pump();
          },
          (error: unknown) => {
            failCandidate(index, error);
          },
        );
      });
    });
  }

  // One whole attempt under ONE deadline, so the bridge's cached
  // promise always settles: the ask gets the whole budget as its
  // timeout, and the candidate race whatever is left of it.
  async function connectDirect(
    deviceId: string,
    opts?: ConnectPeerOpts,
  ): Promise<PeerConnection> {
    const deadlineAt = now() + deadlineMs;
    // This dial's connection: its tickets are minted for it, and its
    // hello names it.
    const connectionId = newConnectionId();
    let answer: unknown;
    try {
      // The input declares this platform's dialable kinds so the host
      // mints no ticket we cannot spend.
      answer = await deps.askConnectInfo(
        deviceId,
        { dialableKinds, connectionId },
        deadlineMs,
      );
    } catch (error) {
      // No direct listener to advertise (a web client), not a call
      // that failed. Terminal, so the keeper parks it until the peer's
      // roster round trip. Every other rejection stays as thrown:
      // transient.
      if (
        error instanceof HubAskRefusedError &&
        error.code === NO_LISTENER_CODE
      ) {
        throw new NoDialableCandidateError(deviceId);
      }
      throw error;
    }
    const info = Schema.decodeUnknownSync(DirectConnectInfoSchema)(answer);
    if (!info.available) {
      // The peer's listener is down, or it has nothing THIS caller can
      // dial. Unreachable for data RIGHT NOW, which is not the same as
      // structurally undialable: its listener may be mid-boot, or the
      // directConnections opt-out may be flipped back on without any
      // roster transition to unpark on. So this stays a plain,
      // transient error and the keeper keeps it on the ladder.
      throw new Error(`peer ${deviceId} offers no direct listener`);
    }
    const localKey = deps.localKey();
    const remoteKey = deps.peerKey(deviceId);
    if (localKey === null || remoteKey === undefined) {
      throw new Error(`peer ${deviceId} has no key on the roster`);
    }
    // The fan-out cap keeps a hostile or buggy answer from dialing an
    // unbounded burst.
    const connection = await raceCandidates(
      deviceId,
      opts,
      info.candidates.slice(0, MAX_DIAL_CANDIDATES),
      Math.max(1, deadlineAt - now()),
      { localKey, remoteKey },
      connectionId,
    );
    return {
      ...connection,
      acceptsCommands: info.acceptsCommands,
      sharesData: info.sharesData,
    };
  }

  return { connectDirect };
}
