import { DeviceStatusDot } from "@/components/remote/DeviceStatusDot";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  type SegmentedOption,
  SegmentedControl,
} from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
import { useAccountStatus } from "@/hooks/account/useAccount";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDevice } from "@/lib/remote/devices";
import { localDeviceId } from "@/lib/queryKeys";

// The Device area's tab strip: this window's machine plus every peer
// the account registry knows, each carrying the status dot the rest of
// the app draws for it (tone from deviceStatusView, so a phase reads
// the same here as on the Devices page). Picking an option re-scopes
// the device-managed sections below to that machine.
//
// The local option needs no registry entry and no dot mapping: the
// window is by definition talking to its own device, so it is the
// emerald "live" tone by construction.
export function DeviceSwitcher({
  devices,
  selectedPeer,
  onChange,
}: {
  devices: readonly RemoteDevice[];
  // The peer being edited, or undefined for this device.
  selectedPeer: RemoteDevice | undefined;
  onChange: (deviceId: string) => void;
}) {
  const { data: account } = useAccountStatus();
  const options: SegmentedOption<string>[] = [
    {
      value: localDeviceId,
      title: "The machine this window runs on",
      label: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone="emerald" />
          This device
        </span>
      ),
    },
    ...devices.map((device) => {
      const { tone, label } = deviceStatusView(device.status);
      return {
        value: device.deviceId,
        title: label,
        label: (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={tone} />
            {device.label}
          </span>
        ),
      };
    }),
  ];

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Device</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Pick the machine to configure. Everything below is stored on that
          device and applies wherever it runs.
        </p>
      </div>
      <SegmentedControl
        value={selectedPeer?.deviceId ?? localDeviceId}
        onChange={onChange}
        options={options}
        aria-label="Device whose settings to edit"
        className="max-w-full flex-wrap"
      />
      {/* Which machine that selection actually is: the account name for
          this one, the live phase for a peer. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">
          {selectedPeer?.label ?? account?.deviceName ?? "This device"}
        </span>
        {selectedPeer === undefined ? (
          <StatusDot tone="emerald" label="This device" />
        ) : (
          <DeviceStatusDot status={selectedPeer.status} />
        )}
      </div>
    </section>
  );
}
