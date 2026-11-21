// A Colibrii device stand-in for a build with no account service, or a
// device that could not be made: signed out, and every call a defect
// that says why.
import type { Device } from "@colibrii/sdk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const inertDevice = (why: unknown): Device => {
  const refused = Effect.die(why);
  return {
    account: Stream.make({ _tag: "SignedOut", removed: false } as const),
    roster: Stream.make([]),
    tunnel: Stream.make({ status: "off" } as const),
    enroll: () => refused,
    signOut: Effect.void,
    devices: {
      list: refused,
      rename: () => refused,
      setData: () => refused,
      remove: () => refused,
    },
    dial: () => refused,
    wake: Effect.void,
  };
};
