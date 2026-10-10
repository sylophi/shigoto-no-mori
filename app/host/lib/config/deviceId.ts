// The deviceId is a UUID naming this data dir, minted with its store on
// first use and durable for its lifetime. It is never derived from the
// machine. Read once at launch, then answered from memory: the id flows
// into every host-scoped query key, and some of its readers can't wait.
import * as Effect from "effect/Effect";
import * as Ops from "../engineOps";

let cached = "";

export const readDeviceId = Effect.tap(Ops.deviceId, (id) =>
  Effect.sync(() => {
    cached = id;
  }),
);

// The shell learns it from its host (main/hostProcess.ts), whose store
// holds it.
export function setDeviceId(deviceId: string): void {
  cached = deviceId;
}

export function getDeviceId(): string {
  if (cached === "")
    throw new Error("The device id was asked before launch read it.");
  return cached;
}
