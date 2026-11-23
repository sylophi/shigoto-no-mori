// The account as the control ops read it (ops.ts, peers.ts): the device
// registry, and which peers have a
// direct session up, which is the hub status snapshot's. The root
// provides it (host/process/handlers.ts). The peers themselves are
// reached through PeerReach (host/ipc/PeerReach.ts).
import { ControlError } from "@shigomori/contracts/modules/control";
import { messageOf } from "@shigomori/engine/errorDocument";
import {
  HubCredentialRejectedError,
  type HubRateLimitedError,
  HubUpdateRequiredError,
  isHubRateLimitedError,
  isHubRefusal,
} from "@shigomori/contracts/errors";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { answerWithin } from "@shigomori/engine/liveness";
import { byHostKind } from "@shigomori/engine/platform";
import * as Schema from "effect/Schema";
import { BLOCKED } from "@shared/hub/directPlane";

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

const ACCOUNT_READ_SECONDS = 15;

// The device list as the terminal's verbs wait on it: a hub that takes
// the read and never answers, through a wait this host ran (not one it
// was stopped for, answerWithin), ends as the account out of reach.
export const withinAccountRead = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  answerWithin(read, ACCOUNT_READ_SECONDS * 1_000).pipe(
    Effect.flatMap((answered): Effect.Effect<A, E | AccountUnreachableError> =>
      Option.isSome(answered)
        ? answered.value
        : Effect.fail(
            new AccountUnreachableError({
              reason: `it didn't answer in ${ACCOUNT_READ_SECONDS} s`,
            }),
          ),
    ),
  );

export const signedOut = () =>
  new ControlError(
    "signed-out",
    `This device isn't signed in to an account, so it has no other devices to reach. ${byHostKind(
      {
        app: "Sign in from the app first.",
        headless: "Sign in first (`login`).",
      },
    )}`,
  );

// A blocked device's words in a window (BLOCKED), as a sentence.
const sentenceOf = (words: string) =>
  `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;

const signInAgain = () =>
  byHostKind({
    app: "Sign in again from the app.",
    headless: "Sign in again (`login`).",
  });

// Why the device list failed, in the words the terminal prints: a
// device signed out since its account was read reads as signed out, a
// hub that wants a newer build says so, a credential the hub no longer
// honors or a device removed from the account is signed in again, the
// hub's rate limit crosses as itself (the terminal says when to try
// again), and anything else is the hub out of reach, with its cause.
export function listDevicesFailure(
  error: unknown,
): ControlError | AccountUnreachableError | HubRateLimitedError {
  if (isHubRateLimitedError(error)) return error;
  if (Predicate.isTagged(error, "NotEnrolled")) return signedOut();
  if (error instanceof HubUpdateRequiredError) {
    return new ControlError(
      "device-blocked",
      sentenceOf(BLOCKED["update-required"]),
    );
  }
  if (error instanceof HubCredentialRejectedError) {
    return new ControlError(
      "signed-out",
      `${sentenceOf(BLOCKED.refused)} ${signInAgain()}`,
    );
  }
  return isHubRefusal(error)
    ? new ControlError(
        "signed-out",
        `This device's access to the account was removed. ${signInAgain()}`,
      )
    : new AccountUnreachableError({ reason: messageOf(error) });
}
