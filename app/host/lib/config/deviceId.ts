// The deviceId is a UUID naming this data dir, minted with its store on
// first use and durable for its lifetime. It is never derived from the
// machine. Read once at launch, then answered from memory: the id flows
// into every host-scoped query key, and some of its readers can't wait.
import * as Registry from "@shigomori/engine/Registry";
import * as Effect from "effect/Effect";
import * as Engine from "../engine";

let cached = "";

export async function readDeviceId(): Promise<string> {
  cached = await Engine.run(
    Effect.gen(function* () {
      return yield* (yield* Registry.Registry).deviceId;
    }),
  );
  return cached;
}

export function getDeviceId(): string {
  if (cached === "")
    throw new Error("The device id was asked before launch read it.");
  return cached;
}
