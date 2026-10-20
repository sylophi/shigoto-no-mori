// The account as the control ops read it (ops.ts, peers.ts): the device
// registry, which rides the stored credential, and which peers have a
// direct session up, which is the hub status snapshot's. The root
// provides it (host/process/handlers.ts). The peers themselves are
// reached through PeerReach (host/ipc/PeerReach.ts).
import { ControlError } from "@shigomori/contracts/modules/control";
import { errorWordsOf } from "@host/lib/errorWords";
import {
  type HubRateLimitedError,
  isHubRateLimitedError,
  isHubRefusal,
} from "@shigomori/contracts/errors";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { answerWithin } from "@shigomori/engine/liveness";
import * as Schema from "effect/Schema";

export type DirectPeer = {
  readonly sharesData: boolean;
  readonly acceptsCommands: boolean;
};

// The account's hub out of reach while listing the devices: a network
// down, the hub redeploying.
export class AccountUnreachableError extends Schema.TaggedError<AccountUnreachableError>()(
  "AccountUnreachableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Couldn't reach your account to find your devices (${this.reason}). Check the network, then try again.`;
  }
}

export class AccountPeers extends Context.Service<
  AccountPeers,
  {
    // The account's device registry. Empty when signed out.
    readonly listDevices: Effect.Effect<
      DeviceInfo[],
      ControlError | AccountUnreachableError | HubRateLimitedError
    >;
    // The devices a direct session is established to (the only ones a
    // call can reach), each with whether it shares with this device and
    // runs its commands: the hub status snapshot's peerSharesData and
    // peerAcceptsCommands, the same reading the app's windows show.
    readonly directPeers: Effect.Effect<Readonly<Record<string, DirectPeer>>>;
  }
>()("sm/host/AccountPeers") {}

// The device list as the terminal's verbs wait on it: a hub that takes
// the read and never answers, through a wait this host ran (not one it
// was stopped for, answerWithin), ends as the account out of reach.
export const withinAccountRead = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  seconds = 15,
) =>
  answerWithin(read, seconds * 1_000).pipe(
    Effect.flatMap(
      (answered): Effect.Effect<A, E | AccountUnreachableError> =>
        Option.isSome(answered)
          ? answered.value
          : Effect.fail(
              new AccountUnreachableError({
                reason: `it didn't answer in ${seconds} s`,
              }),
            ),
    ),
  );

// Why the device list failed, in the words the terminal prints: a
// credential the hub no longer honors (the device was removed from the
// account while the app held it) is the signed-out case, the hub's rate
// limit crosses as itself (the terminal says when to try again), and
// anything else is the hub out of reach, with its cause.
export function listDevicesFailure(
  error: unknown,
): ControlError | AccountUnreachableError | HubRateLimitedError {
  if (isHubRateLimitedError(error)) return error;
  return isHubRefusal(error)
    ? new ControlError(
        "signed-out",
        "This device's access to the account was removed. Sign in again from the app.",
      )
    : new AccountUnreachableError({ reason: errorWordsOf(error) });
}
