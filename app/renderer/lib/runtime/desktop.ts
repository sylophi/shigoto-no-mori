// The desktop window's links: the shell's calls (dialogs, the window,
// the menu, the account) over the port the preload hands over
// (shared/ipc/shell.ts), and the host's, every other, over the loopback
// this machine's host serves its windows (shared/remote/hostLink.ts),
// dialed at the address the shell answers. A peer's host is reached
// through the hub bridge (shared/hub/bridgeHandlers.ts), never by
// swapping these.
import { isHostSide } from "@shigomori/contracts/link";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SHELL_PORT_CHANNEL, shellLink } from "@shared/ipc/shell";
import { type HostAddress, hostLink } from "@shared/remote/hostLink";
import type { ElectronBridge } from "../../../main/preload";
import { ClientLinks } from "./ClientLinks";

export const layer = (bridge: ElectronBridge): Layer.Layer<ClientLinks> =>
  Layer.effect(
    ClientLinks,
    Effect.gen(function* () {
      const port = yield* Effect.callback<MessagePort>((resume) => {
        const onMessage = (event: MessageEvent) => {
          const handed = event.ports[0];
          if (event.data !== SHELL_PORT_CHANNEL || handed === undefined) return;
          window.removeEventListener("message", onMessage);
          resume(Effect.succeed(handed));
        };
        window.addEventListener("message", onMessage);
        bridge.requestShellPort();
        return Effect.sync(() =>
          window.removeEventListener("message", onMessage),
        );
      });
      const shell = yield* shellLink(port);
      const host = yield* hostLink({
        address: shell.call("window:hostAddress", undefined) as Effect.Effect<
          HostAddress,
          unknown
        >,
        appVersion: bridge.appVersion,
        openSocket: (url) => new WebSocket(url),
      });
      // The shell is this window's own build.
      const ownShell = { ...shell, local: true };
      return ClientLinks.of({
        linkOf: (module) => (isHostSide(module) ? host : ownShell),
      });
    }),
  );
