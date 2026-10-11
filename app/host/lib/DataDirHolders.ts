// What holds the data folder beyond the scripts (the store, the
// updater's bridge, the loopback's address file), let go before a move
// takes the folder away (ipc/modules/runtime.ts). The root provides it
// (process/layer.ts), since the loopback is one of its wires.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class DataDirHolders extends Context.Service<
  DataDirHolders,
  { readonly release: Effect.Effect<void> }
>()("sm/host/DataDirHolders") {}
