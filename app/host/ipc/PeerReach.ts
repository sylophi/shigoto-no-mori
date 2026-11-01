// The one seam every reach into a peer device goes through: a client
// for any contract on the peer's direct session, the byte channels of
// that session, and each peer as it comes to take this device's calls.
// The root provides it (host/process/handlers.ts), since the remote
// plumbing lives there, and its calls must route through the
// bridge's SHARED direct-session cache (makeHubHandlers), never a fresh
// dial: the host keeps exactly one authed socket per deviceId, and a
// second dial silently supersedes the session every remote-forest query
// is riding on.
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import type { LinkChannels } from "@shigomori/contracts/link";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { effectClient } from "@shared/ipc/effectClient";
import * as Context from "effect/Context";
import {
  type CallFailure,
  callFailureOf,
  refusalNamed,
} from "@shigomori/contracts/errors";
import {
  callOf,
  channelOf,
  type ContractModule,
} from "@shigomori/contracts/contract";
import type { HubStatus } from "@shigomori/contracts/modules/hub";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { EffectClient, PushKeys } from "@shigomori/contracts/types";

// The byte channels of a peer's cached session, which the source links
// ride (host/lib/sync/sourceLink.ts): resolving once the direct
// session exists, rejecting when there is none.
export type PeerChannels = () => Promise<Pick<LinkChannels, "attach" | "has">>;

// A peer's surface for one contract as effects: built per call, never
// held. Each call continues the caller's span, interrupting it cancels
// it on the peer, and a failure crosses as the contract's error or a
// RemoteCallError (callFailureOf).
export type PeerCalls<M extends ContractModule> = {
  readonly [K in keyof EffectClient<M>]: EffectClient<M>[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer R, unknown>
    ? (...args: A) => Effect.Effect<R, CallFailure>
    : never;
};

export class PeerReach extends Context.Service<
  PeerReach,
  {
    readonly calls: <M extends ContractModule>(
      contract: M,
      deviceId: string,
    ) => PeerCalls<M>;
    // A push of the peer's, until the returned stop.
    readonly onPush: <M extends ContractModule>(
      contract: M,
      key: PushKeys<M>,
      deviceId: string,
      handler: (payload: unknown) => void,
    ) => () => void;
    readonly channels: (deviceId: string) => PeerChannels;
    // Each peer as it comes to take this device's calls: its direct
    // session up with both of its switches on.
    readonly admissions: Stream.Stream<string>;
    // Whether the peer takes this device's calls now.
    readonly admits: (deviceId: string) => boolean;
  }
>()("sm/host/PeerReach") {}

export const make = (reach: {
  // A call on the peer's cached session.
  readonly invoke: (
    deviceId: string,
    channel: string,
    input: unknown,
  ) => Effect.Effect<unknown, unknown>;
  // One channel of the peer's pushes, until the returned stop.
  readonly onPush: (
    deviceId: string,
    channel: string,
    handler: (payload: unknown) => void,
  ) => () => void;
  readonly channelsFor: (deviceId: string) => PeerChannels;
  // A check that doesn't exercise them has none, and every peer taking
  // this device's calls.
  readonly admissions?: Stream.Stream<string>;
  readonly admits?: (deviceId: string) => boolean;
}): PeerReach["Service"] =>
  PeerReach.of({
    admissions: reach.admissions ?? Stream.never,
    admits: reach.admits ?? (() => true),
    calls: <M extends ContractModule>(contract: M, deviceId: string) => {
      const calls = effectClient(contract, {
        call: (channel, input) =>
          reach
            .invoke(deviceId, channel, input)
            .pipe(
              Effect.mapError((error) =>
                refusalNamed(callFailureOf(error), deviceId),
              ),
            ),
      });
      // oxlint-disable-next-line shigomori/no-double-cast -- each call fails only as the CallFailure mapped above
      return calls as unknown as PeerCalls<M>;
    },
    onPush: (contract, key, deviceId, handler) =>
      reach.onPush(deviceId, channelOf(callOf(contract, key)), handler),
    channels: reach.channelsFor,
  });

// The admissions, off the hub's status snapshots (host/process/wires.ts
// notes each): a peer is admitted as it comes into the set of those
// taking this device's calls, and again after it left it.
export const makeAdmissions = Effect.map(
  PubSub.unbounded<string>(),
  (admissions) => {
    let admitted = new Set<string>();
    return {
      note: (
        status: Pick<
          HubStatus,
          "peerAppVersions" | "peerAcceptsCommands" | "peerSharesData"
        >,
      ) => {
        const now = new Set(
          Object.keys(status.peerAppVersions).filter(
            (peer) =>
              status.peerAcceptsCommands[peer] === true &&
              status.peerSharesData[peer] === true,
          ),
        );
        for (const peer of now) {
          if (!admitted.has(peer)) PubSub.publishUnsafe(admissions, peer);
        }
        admitted = now;
      },
      admissions: Stream.fromPubSub(admissions),
      admits: (peer: string) => admitted.has(peer),
    };
  },
);

// The same, for an effect that has the service to hand.
export const peerEffects = <M extends ContractModule>(
  contract: M,
  deviceId: string,
): PeerEffects<M> =>
  new Proxy({} as PeerEffects<M>, {
    get:
      (_, method: string) =>
      (...args: unknown[]) =>
        Effect.flatMap(PeerReach, (reach) => {
          const call: unknown = Reflect.get(
            reach.calls(contract, deviceId),
            method,
          );
          return typeof call === "function"
            ? (call(...args) as Effect.Effect<unknown, CallFailure>)
            : Effect.die(new Error(`no call ${method} on the peer`));
        }),
  });

export type PeerEffects<M extends ContractModule> = {
  readonly [K in keyof PeerCalls<M>]: PeerCalls<M>[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer R, CallFailure>
    ? (...args: A) => Effect.Effect<R, CallFailure, PeerReach>
    : never;
};

export const peerSyncFor = (deviceId: string) =>
  peerEffects(syncContract, deviceId);
export const peerMirrorFor = (deviceId: string) =>
  peerEffects(mirrorContract, deviceId);
export const peerWorktreesFor = (deviceId: string) =>
  peerEffects(worktreesContract, deviceId);
export const peerWorktreeDataFor = (deviceId: string) =>
  peerEffects(worktreeDataContract, deviceId);

// The byte channels of a peer's direct session.
export const peerChannelsFor = (deviceId: string) =>
  Effect.flatMap(PeerReach, (reach) =>
    Effect.tryPromise({
      try: () => reach.channels(deviceId)(),
      catch: callFailureOf,
    }),
  );

// One of a peer's worktrees, read off its own list (which the peer's
// client decoded): its root path flows into a session this device
// persists, so the caller's say-so is never the source of it.
// undefined when the peer no longer lists it.
export const peerWorktree = (
  deviceId: string,
  projectId: string,
  worktreeId: string,
) =>
  Effect.map(peerWorktreesFor(deviceId).list({ projectId }), (worktrees) =>
    worktrees.find((worktree) => worktree.id === worktreeId),
  );
