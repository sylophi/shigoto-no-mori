import { useNavigate, useSearch } from "@tanstack/react-router";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useDeviceProperName } from "@/hooks/remote/useRemoteDevices";
import { DEVICE_TERMINALS_PATH } from "@/lib/routePaths";
import { DeviceTerminalsPageView } from "@shigomori/ui/views/terminal/DeviceTerminalsPageView.tsx";
import { TerminalTabs } from "./TerminalTabs";

// The scoped device's own terminals, the picked one in the URL.
export function DeviceTerminals() {
  const { deviceId } = useHostScope();
  const deviceName = useDeviceProperName(deviceId);
  const { terminal } = useSearch({ strict: false }) as { terminal?: string };
  const navigate = useNavigate();
  return (
    <DeviceTerminalsPageView deviceName={deviceName}>
      <TerminalTabs
        owner={{ kind: "device" }}
        picked={terminal ?? null}
        onPick={(terminalId) =>
          void navigate({
            to: DEVICE_TERMINALS_PATH,
            params: { deviceId },
            search: { terminal: terminalId },
            replace: true,
          })
        }
      />
    </DeviceTerminalsPageView>
  );
}
