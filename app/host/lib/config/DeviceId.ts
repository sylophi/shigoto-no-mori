// This device's id: a UUID naming this data dir, minted with its store
// on first use and durable for its lifetime, never derived from the
// machine. Read from the store once as the graph comes up, then
// answered from memory.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ops from "../engineOps";

export class DeviceId extends Context.Service<
  DeviceId,
  { readonly id: string }
>()("sm/host/DeviceId") {}

export const layer = Layer.effect(
  DeviceId,
  Effect.map(Ops.deviceId, (id) => DeviceId.of({ id })),
);

// The id, for an effect.
export const current = Effect.map(DeviceId, (it) => it.id);
