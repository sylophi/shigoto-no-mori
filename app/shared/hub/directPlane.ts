// The peer plane over this device's Colibrii device (@colibrii/sdk):
// the renderer-facing bridge (bridgeHandlers.ts), the keeper
// (directKeeper.ts) on the device's roster, and the status the windows
// read, from the device's account, roster and tunnel. The host
// (host/process/wires.ts) and the web bridge (web/ipc/register.ts)
// differ only by these deps.
//
// Pure aside from the injected deps (no electron, no node builtins). It
// lives as long as the scope it is made in (quit, a tab's teardown).
import type { AccountState, Device, TunnelState } from "@colibrii/sdk";
import { callOf, channelOf, payloadOf } from "@shigomori/contracts/contract";
import { accountContract } from "@shigomori/contracts/modules/account";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import type {
  HubPeerPush,
  HubSocketStatus,
  HubStatus,
} from "@shigomori/contracts/modules/hub";
import { makeHubHandlers, type HubHandlers } from "@shared/hub/bridgeHandlers";
import * as DirectKeeper from "@shared/hub/directKeeper";
import { type DialedDevice, peerLink } from "@shared/remote/deviceLink";
import { decodeWelcome, encodeHello } from "@shared/remote/greeting";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// The peer's command-access switch flipping, as its host pushes it. The
// bridge records it on the peer's session so the status snapshot's
// peerAcceptsCommands follows the switch live.
const COMMAND_ACCESS_CHANGED = callOf(accountContract, "commandAccessChanged");
// The peer's sharing switch flipping, kept the same way as
// peerSharesData.
const SHARING_CHANGED = callOf(sharingContract, "changed");

// A DialedDevice, plus the host's switches its welcome carried, which
// the bridge keeps current from the peer's pushes.
export type PeerConnection = DialedDevice & {
  acceptsCommands: boolean;
  sharesData: boolean;
};

// A welcome this build can't read.
class UnreadableWelcomeError extends Data.TaggedError(
  "UnreadableWelcomeError",
)<{ readonly deviceId: string }> {
  override get message(): string {
    return `${this.deviceId} answered a welcome this build can't read`;
  }
}

// What of the Colibrii device the plane uses, which the checks stand in
// for.
export type PeerDevice = Pick<Device, "account" | "roster" | "dial" | "wake">;

export type DirectPlaneDeps = {
  readonly device: PeerDevice;
  // Identity facts, as getters because the host's are post-boot facts
  // read on first dial, not at wiring time.
  localDeviceId(): string;
  localAppVersion(): string;
  // The owner's fan-out sinks: every window the host serves, the tab's
  // own wire in the browser.
  broadcastStatus(status: HubStatus): void;
  broadcastPeerPush(push: HubPeerPush): void;
  // This device's tunnel, absent on the web client, which runs none.
  readonly tunnel?: Stream.Stream<TunnelState>;
};

export type DirectPlane = {
  // The renderer-facing hub bridge, for the contract registration.
  // Teardown is the plane's scope closing, not a call in here.
  handlers: HubHandlers;
};

// The words a person reads for each socket a person must act on.
const BLOCKED = {
  revoked: "this device was removed from the account, sign in again",
  superseded: "another instance of this device took over its connection",
  refused: "the account service no longer takes this device's sign-in",
  "update-required": "the account service needs a newer version of the app",
} as const;

const blocked = (reason: keyof typeof BLOCKED): HubSocketStatus => ({
  phase: "blocked",
  reason,
  message: BLOCKED[reason],
});

const socketOf = (account: AccountState): HubSocketStatus => {
  if (Predicate.isTagged(account, "SignedOut")) {
    return account.removed ? blocked("revoked") : { phase: "stopped" };
  }
  if (Predicate.isTagged(account, "Enrolled")) {
    return { phase: account.connected ? "connected" : "connecting" };
  }
  return blocked(
    account.reason === "credential-rejected" ? "refused" : account.reason,
  );
};

// The plane, until its scope closes, which latches the keeper and then
// closes every cached peer session.
export const make = (
  deps: DirectPlaneDeps,
): Effect.Effect<DirectPlane, never, Scope.Scope> =>
  Effect.gen(function* () {
    let socket: HubSocketStatus = { phase: "stopped" };
    let online: ReadonlyArray<string> = [];
    let tunnel: TunnelState["status"] = "off";

    // Pushes received on a peer link are the only peer pushes there are.
    const onPush = (deviceId: string, channel: string, payload: unknown) => {
      if (channel === channelOf(COMMAND_ACCESS_CHANGED)) {
        const accepts = Schema.decodeUnknownResult(
          payloadOf(COMMAND_ACCESS_CHANGED),
        )(payload);
        if (Result.isSuccess(accepts)) {
          handlers.setPeerFact(deviceId, "acceptsCommands", accepts.success);
        }
      }
      if (channel === channelOf(SHARING_CHANGED)) {
        const shares = Schema.decodeUnknownResult(payloadOf(SHARING_CHANGED))(
          payload,
        );
        if (Result.isSuccess(shares)) {
          handlers.setPeerFact(deviceId, "sharesData", shares.success);
        }
      }
      deps.broadcastPeerPush({ deviceId, channel, payload });
    };

    const connectPeer = (deviceId: string) =>
      Effect.gen(function* () {
        const link = yield* deps.device.dial(
          deviceId,
          encodeHello(deps.localAppVersion()),
        );
        const welcome = decodeWelcome(link.greeting);
        if (welcome === null) {
          return yield* new UnreadableWelcomeError({ deviceId });
        }
        const dialed = yield* peerLink(link, welcome, {
          localDeviceId: deps.localDeviceId(),
          onPush: (channel, payload) => onPush(deviceId, channel, payload),
        });
        return {
          ...dialed,
          acceptsCommands: welcome.acceptsCommands,
          sharesData: welcome.sharesData,
        } satisfies PeerConnection;
      });

    const status = (): HubStatus => ({
      socket,
      onlineDeviceIds: [...online],
      // Each established session's version, command access and
      // sharing. peerAppVersions' keys are the session set (the
      // renderer derives connectedness from them).
      ...handlers.directPeers(),
      peerCoreOutdated: keeper.coreOutdated(),
      ...(deps.tunnel === undefined ? {} : { tunnel }),
    });
    const notifyStatusChanged = () => deps.broadcastStatus(status());

    const handlers: HubHandlers = yield* makeHubHandlers({
      status,
      connectDirect: connectPeer,
      onDirectChange: notifyStatusChanged,
      // The keeper's redial signal and its no-session explanation. Both
      // close over the binding below, resolved lazily and only ever
      // fired after creation.
      onPeerDropped: (deviceId) => keeper.peerDropped(deviceId),
      peerUnavailableReason: (deviceId) => keeper.unavailableReason(deviceId),
    });

    // Registered before the keeper's scope, so the sessions close once
    // the keeper is latched: a redial firing during the close would dial
    // fresh sessions into a teardown.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => handlers.closeDirectPeers()),
    );

    const keeper: DirectKeeper.DirectKeeper = yield* DirectKeeper.make({
      dial: (deviceId) => handlers.dialPeer(deviceId),
      onCoreOutdatedChange: notifyStatusChanged,
    });

    const follow = <A>(stream: Stream.Stream<A>, apply: (value: A) => void) =>
      stream.pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => {
            apply(value);
            notifyStatusChanged();
          }),
        ),
        Effect.forkScoped,
      );
    yield* follow(deps.device.account, (account) => {
      socket = socketOf(account);
    });
    // The peers to keep a session with. Colibrii closes the links of a
    // peer that left.
    yield* follow(deps.device.roster, (peers) => {
      online = peers.map((peer) => peer.deviceId);
      keeper.reconcile(online);
    });
    if (deps.tunnel !== undefined) {
      yield* follow(deps.tunnel, (state) => {
        tunnel = state.status;
      });
    }

    return { handlers };
  });
