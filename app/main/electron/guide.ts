// The guide's windows as Electron holds them (core/guide/Guide.ts): a
// window's page driven through its own DevTools protocol client, which
// opens no port, its guide told to it alone, the agent opened by the
// host, and each window as it closes.
import { BrowserWindow, type WebContents } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Layer from "effect/Layer";
import { guideContract } from "@shigomori/contracts/modules/guide";
import { layerLatch } from "@shared/layerLatch";
import * as Guide from "../core/guide/Guide";
import { host } from "../hostProcess";
import { broadcast } from "../ipc/register";
import { liveWindow, navigateWindow, onWindowClosed } from "./windows";

// The protocol version Electron's debugger speaks.
const PROTOCOL = "1.3";

// How long a page takes in a click or a key before the guide reads it.
const SETTLE = "150 millis";

// Attached again when something else detached it (opening DevTools
// does).
const attach = (webContents: WebContents) =>
  Effect.try({
    try: () => {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach(PROTOCOL);
      }
    },
    catch: (cause) => new Guide.GuidePageFailed({ method: "attach", cause }),
  });

const attached = (webContents: WebContents) =>
  Effect.acquireRelease(attach(webContents), () =>
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
          attach(webContents).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: (): Promise<unknown> =>
                  webContents.debugger.sendCommand(method, params),
                catch: (cause) => new Guide.GuidePageFailed({ method, cause }),
              }),
            ),
          );
        return {
          send,
          route: Effect.sync(() => liveWindow(windowId)?.route ?? ""),
          navigate: (route) =>
            Effect.sync(() => navigateWindow(windowId, route)),
          // At the window's own size, which is all an agent reads, not
          // the display's pixels.
          screenshot: Effect.tryPromise({
            try: async () => {
              const image = await webContents.capturePage();
              const [width] =
                BrowserWindow.fromWebContents(webContents)?.getContentSize() ??
                [];
              return (width === undefined ? image : image.resize({ width }))
                .toPNG()
                .toString("base64");
            },
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
    launch: (input) =>
      Effect.tryPromise({
        try: () => host().guideLaunch(input),
        catch: callFailureOf,
      }),
    closed: Stream.callback<number>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          onWindowClosed((windowId) => Queue.offerUnsafe(queue, windowId)),
        ),
        (forget) => Effect.sync(forget),
      ),
    ),
  }),
);

// The guide, for the shell's handlers and its host's calls, with the
// context its layer was built in, so its spans reach the shell's trace.
const guide = layerLatch<{
  readonly service: Guide.Guide["Service"];
  readonly context: Context.Context<never>;
}>("The guide");

export const layer = Layer.effectDiscard(
  guide.provide(
    Effect.gen(function* () {
      const service = yield* Guide.Guide;
      return { service, context: yield* Effect.context<never>() };
    }),
  ),
).pipe(Layer.provide(Guide.layer), Layer.provide(windowsLayer));

// A guide call from a window or the host: its failure as an Error, which
// the wire carries with its message and code.
export const onGuide = <A, E>(
  use: (service: Guide.Guide["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(guide.get).then(({ service, context }) =>
    Effect.runPromiseWith(context)(use(service)),
  );
