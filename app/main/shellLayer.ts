// The shell's layer graph: the Electron side that stays in main when the
// host moves out (step 4 of V3.md). It is built on top of the host's
// graph (hostLayer.ts), so it comes up after it and goes down before it.
import { powerMonitor } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { repairCliLinks } from "./electron/cliInstall";
import { startUpdater } from "./electron/updater";
import { retryParkedSignOut } from "./ipc/modules/account";
import { probeRemoteConnections, shellLinkLayer } from "./ipc/register";
import { lifetime, starts } from "./lifetimes";

// Sleep is the one event that reliably kills every remote socket
// without a close: on resume, the hub socket and every direct session
// are probed, so the dead ones are redialed within seconds rather than
// read as connected until the next heartbeat.
const resumeProbe = lifetime(
  "the resume probe",
  Effect.sync(() => void powerMonitor.on("resume", probeRemoteConnections)),
  () => void powerMonitor.off("resume", probeRemoteConnections),
);

export const layer = Layer.mergeAll(
  starts("the updater", startUpdater),
  // A sign-out whose revoke never reached the hub, delivered after the
  // host's hub socket started and never ahead of it: it can wait out
  // its timeout on a dead network, and a parked revoke means this
  // device is signed out, so the socket has nothing to learn from it.
  starts("the parked sign-out", () => void retryParkedSignOut()),
  resumeProbe,
  // Installing the CLI link is a Settings action. Launch only repairs
  // an installed link whose target moved (an app update, another
  // checkout).
  starts("the CLI link repair", () => void repairCliLinks()),
  // The windows' links to the shell (ipc/shellLink.ts).
  shellLinkLayer,
);
