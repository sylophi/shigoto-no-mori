// The Devices page as the desktop Studio Mac sees it: signed in as
// rin, this device online and reachable from anywhere with control
// allowed, the Thinkpad connected with its dev server forwarded, the
// Mini and the Work PC away. The window's main pane only: the sidebar
// beside it is a scene of its own.
import { DevicesPageView } from "@/components/remote/DevicesPageView";
import { LAB_ACCOUNT_ID } from "../fixtures";
import { devicesPageRows } from "./world";

// The page itself, for a window that brings its own main pane.
export function DevicesPane() {
  return (
    <DevicesPageView
      person="rin@example.com"
      accountId={LAB_ACCOUNT_ID}
      rows={devicesPageRows()}
      canForwardPorts
      launchAtLoginSupported
    />
  );
}

// The page in the main pane's frame (AppShell's main zone, which
// carries the canvas and its doubutsu wallpaper), filling the height
// it is given.
export function DevicesScene() {
  return (
    <main
      data-doubutsu-zone="main"
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <DevicesPane />
    </main>
  );
}
