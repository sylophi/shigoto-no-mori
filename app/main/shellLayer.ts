// The shell's layer graph: the Electron side of the app. The host is a
// process of its own (main/hostProcess.ts).
import { powerMonitor } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { lifetime } from "@host/lib/util/lifetimes";
import { host } from "./hostProcess";
import * as Updater from "./electron/updater";
import { shellLinkLayer } from "./ipc/register";

// Sleep is the one event that reliably kills every remote socket
// without a close: on resume, the host probes the hub socket and every
// direct session, so the dead ones are redialed within seconds rather
// than read as connected until the next heartbeat.
const wake = () => void host().wake();
const resumeProbe = lifetime(
  "the resume probe",
  Effect.sync(() => void powerMonitor.on("resume", wake)),
  () => void powerMonitor.off("resume", wake),
);

export const layer = Layer.mergeAll(
  Updater.layer,
  resumeProbe,
  // The windows' links to the shell (ipc/shellLink.ts).
  shellLinkLayer,
);
