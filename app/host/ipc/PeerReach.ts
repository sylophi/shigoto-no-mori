// The one seam every reach into a peer device goes through: a client
// for any contract on the peer's direct session, and the byte channels
// of that session. The root provides it (host/process/handlers.ts),
// since the remote plumbing lives there, and its transport must route
// through the bridge's SHARED direct-session cache (makeHubHandlers),
// never a fresh dial: the host keeps exactly one authed socket per
// deviceId, and a second dial silently supersedes the session every
// remote-forest query is riding on.
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import type { ChannelMux } from "@shared/remote/channels";
import { syncContract } from "@shigomori/contracts/modules/sync";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { buildClient } from "@shared/ipc/buildClient";
import type { ClientTransport } from "@shared/ipc/transport";
import * as Context from "effect/Context";
import type * as Tracer from "effect/Tracer";
import { type CallFailure, callFailureOf } from "@shigomori/contracts/errors";
import { nameOf } from "@shigomori/contracts/contract";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ContractModule } from "@shigomori/contracts/contract";
import type { Client } from "@shigomori/contracts/types";

// The byte channels of a peer's cached session, which the source links
// ride (host/lib/sync/sourceLink.ts): resolving once the direct
// session exists, rejecting when there is none.
export type PeerChannels = () => Promise<Pick<ChannelMux, "attach" | "has">>;

export class PeerReach extends Context.Service<
  PeerReach,
  {
    // A peer's surface for one contract, on the cached direct session:
    // built per call, never held. Each call continues `span`, and
    // `signal` cancels it on the peer.
    readonly client: <M extends ContractModule>(
      contract: M,
      deviceId: string,
      options?: {
        readonly signal?: AbortSignal;
        readonly span?: Tracer.AnySpan | undefined;
      },
    ) => Client<M>;
    readonly channels: (deviceId: string) => PeerChannels;
  }
>()("sm/host/PeerReach") {}

export const make = (reach: {
  readonly transportFor: (deviceId: string) => ClientTransport;
  readonly channelsFor: (deviceId: string) => PeerChannels;
}): PeerReach["Service"] =>
  PeerReach.of({
    client: (contract, deviceId, options = {}) => {
      const transport = reach.transportFor(deviceId);
      return buildClient(contract, {
        invoke: (channel, input) =>
          transport.invoke(channel, input, {
            signal: options.signal,
            span: options.span,
          }),
        subscribe: transport.subscribe,
      });
    },
    channels: reach.channelsFor,
  });

// The same surfaces for effects: each call answers with an effect,
// whose interruption cancels it on the peer and whose span the call
// continues. A failure crosses as the contract's error or a
// RemoteCallError (callFailureOf).
export type PeerEffects<C> = {
  readonly [K in keyof C]: C[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Effect.Effect<R, CallFailure, PeerReach>
    : C[K];
};

export const peerEffects = <M extends ContractModule>(
  contract: M,
  deviceId: string,
): PeerEffects<Client<M>> =>
  new Proxy({} as PeerEffects<Client<M>>, {
    get:
      (_, method: string) =>
      (...args: unknown[]) =>
        Effect.flatMap(
          Effect.all([PeerReach, Effect.option(Effect.currentSpan)]),
          ([reach, span]) =>
            Effect.tryPromise({
              try: (signal) => {
                const call: unknown = Reflect.get(
                  reach.client(contract, deviceId, {
                    signal,
                    span: Option.getOrUndefined(span),
                  }),
                  method,
                );
                if (typeof call !== "function") {
                  throw new Error(`${nameOf(contract)}:${method} is no call`);
                }
                return Promise.resolve(call(...args));
              },
              catch: callFailureOf,
            }),
        ),
  });

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
