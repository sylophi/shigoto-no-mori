import { useMatch, useNavigate, useSearch } from "@tanstack/react-router";
import { useDeviceTabs } from "@/components/shared/DeviceTabs";
import { HostScopeProvider } from "@/hooks/remote/useHostScope";
import { useTerminals } from "@/hooks/terminals/useTerminals";
import { DEVICE_TERMINALS_PATH } from "@/lib/routePaths";
import type { DeviceTab } from "@/components/shared/DeviceTabs";
import {
  SidebarDeviceTerminalsView,
  SidebarTerminalsView,
} from "@shigomori/ui/views/sidebar/SidebarTerminalsView.tsx";

// The folder a terminal started in, as its row names it: its last part.
const folderName = (cwd: string): string =>
  cwd.slice(cwd.replace(/\/+$/, "").lastIndexOf("/") + 1).replace(/\/+$/, "") ||
  "/";

// Every device's own terminals, for the devices that run commands from
// here.
export function SidebarTerminals() {
  const devices = useDeviceTabs().filter(
    (device) => device.block === undefined && device.api !== undefined,
  );
  return (
    <SidebarTerminalsView>
      {devices.map((device) =>
        device.api === undefined ? null : (
          <HostScopeProvider
            key={device.deviceId}
            deviceId={device.deviceId}
            api={device.api}
          >
            <DeviceTerminals device={device} />
          </HostScopeProvider>
        ),
      )}
    </SidebarTerminalsView>
  );
}

function DeviceTerminals({ device }: { device: DeviceTab }) {
  const terminals = useTerminals()?.filter(
    (terminal) => terminal.owner.kind === "device",
  );
  const navigate = useNavigate();
  const onPage = useMatch({
    from: DEVICE_TERMINALS_PATH,
    shouldThrow: false,
    select: (match) => match.params.deviceId === device.deviceId,
  });
  const { terminal: picked } = useSearch({ strict: false }) as {
    terminal?: string;
  };
  if (terminals === undefined || terminals.length === 0) return null;
  const selectedId = onPage
    ? (picked ?? terminals.at(-1)?.terminalId)
    : undefined;
  return (
    <SidebarDeviceTerminalsView
      label={device.label}
      icon={device.icon}
      tone={device.status?.tone ?? null}
      terminals={terminals.map((terminal) => ({
        terminalId: terminal.terminalId,
        label: folderName(terminal.cwd),
        cwd: terminal.cwd,
        selected: terminal.terminalId === selectedId,
      }))}
      onPick={(terminalId) =>
        void navigate({
          to: DEVICE_TERMINALS_PATH,
          params: { deviceId: device.deviceId },
          search: { terminal: terminalId },
        })
      }
    />
  );
}
