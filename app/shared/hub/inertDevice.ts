// A Colibrii device stand-in for a build with no account service, or a
// device that could not be made: signed out, and every call a defect
// that says why.
import type { Device } from "@colibrii/sdk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const inertDevice = (why: unknown): Device => {
  const refused = Effect.die(why);
  return {
    account: Stream.make({ _tag: "SignedOut", removed: false } as const),
    roster: Stream.make([]),
    tunnel: Stream.make({ status: "off" } as const),
    enroll: () => refused,
    signOut: Effect.succeed(true),
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
);

// A device that could not be made stands in signed out.
export const orInertDevice = <E, R>(make: Effect.Effect<Device, E, R>) =>
  make.pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logError("[peers] the device could not start", cause),
        inertDevice(cause),
      ),
    ),
  );
