// A Colibrii device stand-in for a build with no account service, or a
// device that could not be made: signed out, and every call a defect
// that says why.
import type { AccountState, Device } from "@colibrii/sdk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const inertDevice = (
  why: unknown,
  account: AccountState,
  signedOut: boolean,
): Device => {
  const refused = Effect.die(why);
  return {
    account: Stream.make(account),
    roster: Stream.make([]),
    tunnel: Stream.make({ status: "off" } as const),
    enroll: () => refused,
    signOut: Effect.succeed(signedOut),
    devices: {
      list: refused,
      rename: () => refused,
      setData: () => refused,
      remove: () => refused,
    },
    dial: () => refused,
    wake: Effect.void,
    wakes: Stream.never,
  };
};

export const unconfiguredDevice = inertDevice(
  new Error("This build has no account service."),
  { _tag: "SignedOut", removed: false },
  true,
);

// What a device that could not be made reads as: signed out to a call
// that asks, but no news of the account, which may still hold it. Its
// sign-out tells the service nothing.
export const notStarted: AccountState = { _tag: "SignedOut", removed: false };

export const orInertDevice = <E, R>(make: Effect.Effect<Device, E, R>) =>
  make.pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("[peers] the device could not start", cause),
        inertDevice(cause, notStarted, false),
      ),
    ),
  );
