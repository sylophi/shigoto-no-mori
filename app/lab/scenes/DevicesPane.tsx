// The Devices page as the desktop Studio Mac sees it: signed in as
// rin, this device online and reachable from anywhere with control
// allowed, the Thinkpad connected with its dev server forwarded, the
// Mini and the Work PC away. Each row is the registry's own row view
// (DeviceRegistryRowView), its slots filled with the parts' views where
// the live row (DeviceRegistryRow) puts the components that save.
import { SignOutButtonView } from "@/components/account/SignOutButtonView";
import { AcceptCommandsToggleView } from "@/components/remote/AcceptCommandsToggleView";
import { DeviceHostsView } from "@/components/remote/DeviceHostsView";
import { DeviceIconPickerView } from "@/components/remote/DeviceIconPickerView";
import { DeviceNameFieldView } from "@/components/remote/DeviceNameFieldView";
import { DeviceRegistryRowView } from "@/components/remote/DeviceRegistryRowView";
import {
  AccountIdentityView,
  DEVICE_REGISTRY_SIGN_OUT_CLASS,
  DeviceListView,
  DeviceRegistryView,
} from "@/components/remote/DeviceRegistryView";
import { DevicesPageView } from "@/components/remote/DevicesPageView";
import { KeepReachableToggleView } from "@/components/remote/KeepReachableToggleView";
import { PortForwardSectionView } from "@/components/remote/PortForwardSectionView";
import { ProjectIconView } from "@/components/shared/ProjectIconView";
import { LAB_ACCOUNT_ID } from "../fixtures";
import { deviceIconOf } from "./world";
import { type DevicesPageRow, devicesPageRows } from "./world/devicesPage";

export function DevicesPane() {
  return (
    <DevicesPageView>
      <DeviceRegistryView
        identity={
          <AccountIdentityView
            person="rin@example.com"
            accountId={LAB_ACCOUNT_ID}
          />
        }
        signOut={
          <SignOutButtonView className={DEVICE_REGISTRY_SIGN_OUT_CLASS} />
        }
        banner={null}
      >
        <DeviceListView>
          {devicesPageRows().map((row) => (
            <DeviceRow key={row.device.deviceId} row={row} />
          ))}
        </DeviceListView>
      </DeviceRegistryView>
    </DevicesPageView>
  );
}

function DeviceRow({ row }: { row: DevicesPageRow }) {
  const { device, isThisDevice, status } = row;
  const icon = deviceIconOf(device);
  return (
    <DeviceRegistryRowView
      deviceId={device.deviceId}
      platform={device.platform}
      isThisDevice={isThisDevice}
      name={device.name}
      // No two of the lab's devices share a name.
      showId={false}
      status={status}
      appVersion={row.appVersion}
      tunnel={row.tunnel}
      access={row.access}
      // The desktop app forwards ports (a browser cannot).
      canForwardPorts
      renderIconPicker={(label) => (
        <DeviceIconPickerView
          icon={icon}
          tone={status.tone}
          label={label}
          detected={isThisDevice ? icon : undefined}
        />
      )}
      renderNameField={(label) => (
        <DeviceNameFieldView
          deviceName={device.name}
          label={label}
          editing={false}
          className="text-base"
        />
      )}
      renderHosts={(cached) => (
        <DeviceHostsView
          chips={row.chips}
          loading={false}
          cached={cached}
          renderIcon={(chip) => (
            <ProjectIconView
              name={chip.name}
              src={chip.iconSrc}
              className="size-3"
            />
          )}
        />
      )}
      switches={
        <>
          <AcceptCommandsToggleView enabled={row.acceptsCommands} />
          <KeepReachableToggleView
            checked={row.keepReachable ?? false}
            // Studio Mac can start the app at login.
            launchAtLoginSupported
          />
        </>
      }
      portForwards={
        <PortForwardSectionView
          forwards={row.forwards}
          canStart={row.access.granted}
        />
      }
    />
  );
}
