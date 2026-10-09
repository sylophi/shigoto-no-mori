// The engine's updater (packages/engine/src/Updater.ts) as the shell
// runs it: decision 6 of V3.md keeps the updater in Electron's process,
// so it gets a small graph of its own here, over the engine's paths and
// the platform's fetch, files and child processes (the shell's graph,
// main/index.ts, provides the last two).
import * as Paths from "@shigomori/engine/Paths";
import * as Updater from "@shigomori/engine/Updater";
import type { Flavor } from "@shigomori/engine/flavor";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as PromiseAdapter from "@host/lib/util/promiseAdapter";

export const layer = (flavor: Flavor) =>
  Updater.layer(flavor).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(Paths.layer(flavor)),
  );

// The Promise face, for main/electron/updater.ts.
export const { layer: adapter, run } =
  PromiseAdapter.make<Updater.Updater>("The updater");
