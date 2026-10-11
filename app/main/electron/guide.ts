// The guide's windows as Electron holds them (core/guide/Guide.ts): a
// window's page driven through its own DevTools protocol client, which
// opens no port, and its guide told to it alone. A window that closes
// ends its session.
import type { WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { guideContract } from "@shigomori/contracts/modules/guide";
import { layerLatch } from "@host/lib/util/layerLatch";
import * as Guide from "../core/guide/Guide";
import { broadcast } from "../ipc/register";
import { liveWindow, navigateWindow, onWindowClosed } from "./windows";

// The protocol version Electron's debugger speaks.
const PROTOCOL = "1.3";

// How long a page takes in a click or a key before the guide reads it.
const SETTLE = "150 millis";

const attached = (webContents: WebContents) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => webContents.debugger.attach(PROTOCOL),
      catch: () => new Guide.GuideSessionEnded(),
    }),
    () =>
      Effect.sync(() => {
        if (!webContents.isDestroyed() && webContents.debugger.isAttached()) {
          webContents.debugger.detach();
        }
      }),
  );

const windowsLayer = Layer.succeed(
  Guide.GuideWindows,
  Guide.GuideWindows.of({
    attach: (windowId) =>
      Effect.gen(function* () {
        const live = liveWindow(windowId);
        if (live === undefined) return yield* new Guide.GuideSessionEnded();
        const { webContents } = live;
        yield* attached(webContents);
        const send = (method: string, params?: Record<string, unknown>) =>
          Effect.tryPromise({
            try: (): Promise<unknown> =>
              webContents.debugger.sendCommand(method, params),
            catch: (cause) => new Guide.GuidePageFailed({ method, cause }),
          });
        return {
          send,
          route: Effect.sync(() => liveWindow(windowId)?.route ?? ""),
          navigate: (route) =>
            Effect.sync(() => navigateWindow(windowId, route)),
          screenshot: Effect.tryPromise({
            try: async () =>
              (await webContents.capturePage()).toPNG().toString("base64"),
            catch: (cause) =>
              new Guide.GuidePageFailed({ method: "capturePage", cause }),
          }),
          settle: Effect.sleep(SETTLE),
        };
      }),
    tell: (windowId, state) =>
      Effect.sync(() => {
        const live = liveWindow(windowId);
        if (live !== undefined) {
          broadcast(guideContract, "changed", state, live.webContents);
        }
      }),
  }),
);

// The guide, for the shell's handlers and its host's calls.
const guide = layerLatch<Guide.Guide["Service"]>("The guide");

export const layer = Layer.effectDiscard(
  guide.provide(
    Effect.gen(function* () {
      const service = yield* Guide.Guide;
      const runFork = yield* FiberSet.makeRuntime<never>();
      const forget = onWindowClosed((windowId) =>
        runFork(service.end(windowId)),
      );
      yield* Effect.addFinalizer(() => Effect.sync(forget));
      return service;
    }),
  ),
).pipe(Layer.provide(Guide.layer), Layer.provide(windowsLayer));

// A guide call from a window or the host: its failure as an Error, which
// the wire carries with its message and code.
export const onGuide = <A, E>(
  use: (service: Guide.Guide["Service"]) => Effect.Effect<A, E>,
): Promise<A> => Effect.runPromise(Effect.flatMap(guide.get, use));
