// The device drawer: the window's device terminals, shells at home on
// any device that takes commands from here, in the drawer a worktree's
// page has, on every page. A worktree's page draws it in its own
// drawer's place while it is open, and the shell draws it on every
// other. The keymap's terminal (Ctrl+`) shows, focuses or hides it
// where the page has no Terminal button of its own, and the palette
// and Live open it on a terminal.
import { lazy, Suspense, useLayoutEffect, useState } from "react";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { useKeymapAction } from "@/hooks/ui/useKeymap";
import { notifyError } from "@/lib/toast";
import {
  deviceTabId,
  isDeviceDrawerOpen,
  openDeviceTab,
  setDeviceDrawerOpen,
  setDrawerSide,
  setDrawerSize,
  useDrawerSide,
  useTerminalDrawer,
} from "@/store/terminalDrawer";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import { TerminalDrawerView } from "@shigomori/ui/views/terminal/TerminalDrawerView.tsx";
import { toggleTerminalDrawer } from "./TerminalDrawer";

// xterm comes with the first terminal opened, not with the page.
const DeviceTerminalTabs = lazy(() =>
  import("./DeviceTerminalTabs").then((module) => ({
    default: module.DeviceTerminalTabs,
  })),
);

const close = () => setDeviceDrawerOpen(false);

// The worktree pages on screen drawing the drawer themselves.
const pageHosts = createExternalStore(0);

export const usePageHostsDeviceDrawer = (): boolean =>
  useExternalStore(pageHosts) > 0;

// The drawer as a worktree's page draws it, which the shell leaves it
// to.
export function PageDeviceTerminalDrawer() {
  useLayoutEffect(() => {
    pageHosts.publish(pageHosts.get() + 1);
    return () => pageHosts.publish(pageHosts.get() - 1);
  }, []);
  return <DeviceTerminalDrawer />;
}

export function DeviceTerminalDrawer() {
  const state = useTerminalDrawer();
  const side = useDrawerSide();
  const { open } = state.device;
  // Slides in when it opens, not when a page change shows it open.
  const [seen, setSeen] = useState(open);
  const [slideIn, setSlideIn] = useState(false);
  if (seen !== open) {
    setSeen(open);
    setSlideIn(open);
  }
  if (!open) return null;
  return (
    <TerminalDrawerView
      side={side}
      size={side ? state.width : state.height}
      slideIn={slideIn}
      onSize={setDrawerSize}
    >
      <Suspense>
        <DeviceTerminalTabs
          onEmpty={close}
          side={side}
          onDock={() => setDrawerSide(!side)}
          onHide={close}
        />
      </Suspense>
    </TerminalDrawerView>
  );
}

export const toggleDeviceDrawer = (): void =>
  toggleTerminalDrawer(isDeviceDrawerOpen(), setDeviceDrawerOpen);

export function useDeviceDrawerKey(enabled: boolean): void {
  useKeymapAction("terminal", toggleDeviceDrawer, { enabled });
}

export function openDeviceTerminal({
  api,
  deviceId,
}: {
  api: HostApi;
  deviceId: string;
}): void {
  void api
    .run(api.terminals.open({}))
    .then(({ terminalId }) => openDeviceTab(deviceTabId(deviceId, terminalId)))
    .catch((error: unknown) => notifyError("Couldn't open a terminal", error));
}
