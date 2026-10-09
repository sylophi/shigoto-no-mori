// The shell's layer graph: the Electron side of the app, which starts
// the host (host/process/layer.ts) and comes up after it.
import { powerMonitor } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { lifetime, starts } from "@host/lib/util/lifetimes";
import { host } from "./hostProcess";
import { startUpdater } from "./electron/updater";
import { accountFactsForHost, retryParkedSignOut } from "./ipc/modules/account";
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
  starts("the updater", startUpdater),
  // The account as it stands, which brings the host's hub socket up. It
  // reads the credential, which safeStorage cannot decrypt before ready.
  starts("the account report", () => {
    void host().account(accountFactsForHost());
  }),
  // A sign-out whose revoke never reached the hub, delivered after the
  // host's hub socket started and never ahead of it: it can wait out
  // its timeout on a dead network, and a parked revoke means this
  // device is signed out, so the socket has nothing to learn from it.
  starts("the parked sign-out", () => void retryParkedSignOut()),
  resumeProbe,
  // The windows' links to the shell (ipc/shellLink.ts).
  shellLinkLayer,
);
