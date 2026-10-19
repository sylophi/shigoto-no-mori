// The shell's layer graph: the Electron side of the app. The host is a
// process of its own, held by the top layer (main/hostProcess.ts), so
// the quit stops it first: its own quit may still ask for the updater's
// bridge below.
import { powerMonitor } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { lifetime } from "@shared/lifetimes";
import * as HostProcess from "./hostProcess";
import * as Guide from "./electron/guide";
import { loginItemLayer } from "./electron/liveness";
import * as Updater from "./electron/updater";
import { shellLinkLayer } from "./ipc/register";

// Sleep is the one event that reliably kills every remote socket
// without a close: on resume, the host probes the hub socket and every
// direct session, so the dead ones are redialed within seconds rather
// than read as connected until the next heartbeat.
const wake = () => {
  HostProcess.noteWake();
  void Effect.runFork(Effect.ignore(HostProcess.host().wake()));
};
const resumeProbe = lifetime(
  "the resume probe",
  Effect.sync(() => {
    powerMonitor.on("suspend", HostProcess.noteSleep);
    powerMonitor.on("resume", wake);
  }),
  () => {
    powerMonitor.off("suspend", HostProcess.noteSleep);
    powerMonitor.off("resume", wake);
  },
);

export const layer = (host: Parameters<typeof HostProcess.layer>[0]) =>
  HostProcess.layer(host).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Updater.layer,
        resumeProbe,
        // The windows' links to the shell (ipc/ShellLink.ts).
        shellLinkLayer,
        Guide.layer,
        loginItemLayer,
      ),
    ),
  );
