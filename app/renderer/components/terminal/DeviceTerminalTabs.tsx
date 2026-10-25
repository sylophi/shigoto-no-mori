import { useParams } from "@tanstack/react-router";
import { useCommandableDevices } from "@/components/shared/DeviceTabs";
import { useOpenTerminals } from "@/hooks/live/useLiveActivity";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import { useOpenWhenEmpty } from "@/hooks/terminals/useOpenWhenEmpty";
import { notifyError } from "@/lib/toast";
import {
  deviceTabId,
  pickDeviceTab,
  terminalTabLabel,
  useTerminalDrawer,
} from "@/store/terminalDrawer";
import { DeviceGlyphView } from "@shigomori/ui/views/shared/DeviceGlyphView.tsx";
import { DeviceMenuRowView } from "@shigomori/ui/views/sidebar/DeviceMenuRowView.tsx";
import { TerminalTabsView } from "@shigomori/ui/views/terminal/TerminalTabsView.tsx";
import { openDeviceTerminal } from "./DeviceTerminalDrawer";
import { Terminal } from "./Terminal";

// The device terminals of every device that takes commands from here,
// device by device, as tabs over the picked one, the newest until
// another is picked. With more than one such device each tab is named
// for its device, and a new one is opened on a device picked from a
// menu. With no tab at all once that device's terminals are read, one
// is opened as it mounts, on the page's device or else the first (this
// one, when it has a host), and `onEmpty` hears when the last tab goes.
export function DeviceTerminalTabs({
  onEmpty,
  ...placement
}: {
  onEmpty: () => void;
  side?: boolean;
  onDock?: () => void;
  onHide?: () => void;
}) {
  const devices = useCommandableDevices();
  const hosts = useOpenTerminals();
  const { picked } = useTerminalDrawer().device;
  const { deviceId: pageDeviceId } = useParams({ strict: false });
  const named = devices.length > 1;
  const tabs = devices.flatMap((device) =>
    (hosts.find((host) => host.deviceId === device.deviceId)?.terminals ?? [])
      .filter((terminal) => terminal.worktree === undefined)
      .map((terminal, i) => ({
        id: deviceTabId(device.deviceId, terminal.terminalId),
        label: named
          ? i === 0
            ? device.label
            : `${device.label} ${i + 1}`
          : terminalTabLabel(i),
        lead: named ? (
          <DeviceGlyphView icon={device.icon} className="size-3" />
        ) : undefined,
        device,
        terminalId: terminal.terminalId,
        openedAt: terminal.openedAt,
      })),
  );
  const selected =
    tabs.find((tab) => tab.id === picked) ??
    tabs.reduce<(typeof tabs)[number] | undefined>(
      (newest, tab) =>
        newest === undefined || tab.openedAt > newest.openedAt ? tab : newest,
      undefined,
    );
  const first =
    devices.find((device) => device.deviceId === pageDeviceId) ?? devices[0];
  const firstLoading = hosts.some(
    (host) => host.deviceId === first?.deviceId && host.loading,
  );

  useOpenWhenEmpty(
    tabs.length === 0 && firstLoading ? undefined : tabs.length,
    first && (() => openDeviceTerminal(first)),
    onEmpty,
  );

  return (
    <TerminalTabsView
      tabs={tabs}
      selectedId={selected?.id ?? null}
      onSelect={pickDeviceTab}
      onClose={(id) => {
        const tab = tabs.find((each) => each.id === id);
        if (tab === undefined) return;
        const { api } = tab.device;
        void api
          .run(api.terminals.close({ terminalId: tab.terminalId }))
          .catch((error: unknown) =>
            notifyError("Couldn't close the terminal", error),
          );
      }}
      {...(named
        ? {
            newMenu: {
              choices: devices.map((device) => ({
                id: device.deviceId,
                content: (
                  <DeviceMenuRowView icon={device.icon} label={device.label} />
                ),
              })),
              onPick: (deviceId: string) => {
                const device = devices.find(
                  (each) => each.deviceId === deviceId,
                );
                if (device !== undefined) openDeviceTerminal(device);
              },
            },
          }
        : first !== undefined && { onNew: () => openDeviceTerminal(first) })}
      note={
        devices.length === 0
          ? "None of your devices takes commands from this one."
          : null
      }
      {...placement}
    >
      {selected !== undefined && (
        <MaybeHostScope
          deviceId={selected.device.deviceId}
          api={selected.device.api}
        >
          <Terminal key={selected.id} terminalId={selected.terminalId} />
        </MaybeHostScope>
      )}
    </TerminalTabsView>
  );
}
