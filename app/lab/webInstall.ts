// Lab stand-in for web/preload.ts (lab/web-main.tsx calls this in its
// place): the web page boots on the fixture window.api instead of the
// real hub-backed bridge.
import { installLabBridge } from "./bridge";

export function installWebBridge(): void {
  installLabBridge({ webShell: true });
}
