// The shell's wires: the port each window's calls to its shell ride
// (main/ipc/shellLink.ts), the registrar that mounts the shell's modules
// there, and the pushes to one window or every one. The host's modules
// ride the host's own wires (host/process/wires.ts).
import { app, ipcMain, MessageChannelMain, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { layerLatch } from "@host/lib/util/layerLatch";
import { type ContractModule, nameOf } from "@shigomori/contracts/contract";
import { isHostSide } from "@shigomori/contracts/link";
import type {
  BroadcastKeys,
  BroadcastProducerPayload,
  Handlers,
} from "@shigomori/contracts/types";
import {
  broadcastAll as broadcastAllCore,
  registerContract as registerContractCore,
  resolveBroadcast,
} from "@shared/ipc/registerContract";
import { SHELL_PORT_CHANNEL } from "@shared/ipc/shell";
import type { HandlerContext } from "@shared/ipc/transport";
import * as ShellLink from "./shellLink";

// The shell's half of every window's calls: the client modules this
// process owns, registered here and served on the port each window's
// preload asks for (installShellPorts).
const shellRegistrar = ShellLink.createShellRegistrar();

// The link, once its layer is up, with the runtime its work runs in
// for as long as the layer does.
const link = layerLatch<{
  readonly service: ShellLink.ShellLink["Service"];
  readonly run: (effect: Effect.Effect<void>) => void;
}>("The shell link");
export const shellLinkLayer = Layer.effectDiscard(
  link.provide(
    Effect.gen(function* () {
      const service = yield* ShellLink.ShellLink;
      const runFork = yield* FiberSet.makeRuntime<never>();
      return {
        service,
        run: (effect: Effect.Effect<void>) => void runFork(effect),
      };
    }),
  ),
).pipe(Layer.provide(ShellLink.layer(shellRegistrar)));

// Hands each page that loads a port of its own to the shell: the
// preload asks once its window's document runs, and the page takes the
// port with it when it goes.
export function installShellPorts(): void {
  ipcMain.on(SHELL_PORT_CHANNEL, (event) => {
    const { port1, port2 } = new MessageChannelMain();
    // A page that asks before the link is up waits for it.
    void Effect.runPromise(link.get).then(
      ({ service, run }) => run(service.attach(port1, event.sender)),
      () => {},
    );
    event.sender.postMessage(SHELL_PORT_CHANNEL, null, [port2]);
  });
}

export function registerContract<M extends ContractModule>(
  module: M,
  handlers: Handlers<M, HandlerContext>,
): void {
  if (isHostSide(module)) {
    throw new Error(`${nameOf(module)} is the host's, not the shell's`);
  }
  registerContractCore(module, handlers, shellRegistrar, {
    // Handler results are parsed with their output schema in a dev
    // build, so drift surfaces here and not as a confusing failure in
    // the window. A packaged build skips the extra parse.
    validateOutputs: !app.isPackaged,
  });
}

// A push to one window alone (its menu's events, its focus), on its
// shell port.
export function broadcast<M extends ContractModule, K extends BroadcastKeys<M>>(
  module: M,
  key: K,
  payload: BroadcastProducerPayload<M, K>,
  webContents: WebContents,
): void {
  const { channel, parsed } = resolveBroadcast(module, key, payload);
  // Before the link is up no window is listening, and the push goes
  // nowhere.
  const up = link.now();
  up?.run(up.service.pushTo(webContents, { channel, payload: parsed }));
}

// A push to every window, on every window's shell port. One annotated
// `remote` (account:commandAccessChanged) reaches the peers from the
// host, which hears the switch in the account's facts.
export function broadcastAll<
  M extends ContractModule,
  K extends BroadcastKeys<M>,
>(module: M, key: K, payload: BroadcastProducerPayload<M, K>): void {
  broadcastAllCore(module, key, payload, shellRegistrar);
}
