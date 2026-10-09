import { ProjectIcon } from "@/components/shared/ProjectIcon";
import type { HostChip } from "./deviceHostChips";
import { DeviceHostsView } from "./DeviceHostsView";

// A device's project strip (DeviceHostsView), each chip's icon read
// through that machine's api.
export function DeviceHosts({
  deviceId,
  chips,
  ...props
}: {
  deviceId: string;
  chips: readonly HostChip[];
  loading: boolean;
  cached: boolean;
}) {
  return (
    <DeviceHostsView
      {...props}
      chips={chips.map((chip) => ({
        ...chip,
        icon: (
          <ProjectIcon
            projectId={chip.projectId}
            name={chip.name}
            deviceId={deviceId}
            className="size-3"
          />
        ),
      }))}
    />
  );
}
