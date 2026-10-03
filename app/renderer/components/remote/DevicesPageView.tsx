// The Devices page drawn from plain data: the page's shell over a
// signed-in registry, every row's parts drawn by their views. The live
// page (DevicesPage) wears the same shell over AccountSection, and its
// rows are the same DeviceRegistryRowView, so the two cannot drift.
import type { ReactNode } from "react";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { TunnelState } from "@shared/ipc/modules/hub";
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import { SignOutButtonView } from "@/components/account/SignOutButtonView";
import { PageShell } from "@/components/shared/PageShell";
import { ProjectIconView } from "@/components/shared/ProjectIconView";
import type { CommandAccess } from "@/hooks/remote/useCommandAccess";
import { AcceptCommandsToggleView } from "./AcceptCommandsToggleView";
import { DeviceHostsView } from "./DeviceHostsView";
import { DeviceIconPickerView } from "./DeviceIconPickerView";
import { DeviceNameFieldView } from "./DeviceNameFieldView";
import { DeviceRegistryRowView, deviceRowFacts } from "./DeviceRegistryRowView";
import {
  AccountIdentityView,
  DEVICE_REGISTRY_SIGN_OUT_CLASS,
  DeviceListView,
  DeviceRegistryView,
} from "./DeviceRegistryView";
import { KeepReachableToggleView } from "./KeepReachableToggleView";
import { PortForwardSectionView } from "./PortForwardSectionView";
import type { HostChip } from "./deviceHostChips";
import type { DeviceRowStatus } from "./deviceRegistryStatus";

// "/devices": the page's shell, which the live page fills with the
// account's state.
export function DevicesPageShell({ children }: { children: ReactNode }) {
  return (
    <PageShell
      page="devices"
      eyebrow="Shigoto no Mori"
      title="Devices"
      watermark="機器"
    >
      {children}
    </PageShell>
  );
}

// One machine's row, as data.
export type DevicesPageRow = {
  deviceId: string;
  platform: string;
  isThisDevice: boolean;
  name: string;
  icon: DeviceIcon;
  status: DeviceRowStatus;
  // The app version it runs, "" when unknown.
  appVersion: string;
  // Another row wears the same name.
  showId?: boolean;
  // This device's tunnel endpoint state.
  tunnel?: TunnelState;
  // Whether this device may run commands on the peer. Granted unless
  // said otherwise.
  access?: Pick<CommandAccess, "granted" | "isLoading">;
  // Its projects, each with its logo (ProjectIconView's `src`).
  chips: readonly (HostChip & { iconSrc: string | null | undefined })[];
  // This device's two switches.
  acceptsCommands?: boolean;
  keepReachable?: boolean;
  // The forwards this machine holds open to the peer.
  forwards?: readonly Pick<
    PortForwardSummary,
    "forwardId" | "remotePort" | "localPort" | "connCount"
  >[];
};

const GRANTED = { granted: true, isLoading: false };

export function DevicesPageView({
  person,
  accountId,
  rows,
  canForwardPorts,
  launchAtLoginSupported,
}: {
  // Who is signed in, as Clerk knows them (null names the account).
  person: string | null;
  accountId: string;
  // This device first.
  rows: readonly DevicesPageRow[];
  // This client can forward ports (the app can, a browser cannot).
  canForwardPorts: boolean;
  // This device's platform can start the app at login.
  launchAtLoginSupported: boolean;
}) {
  return (
    <DevicesPageShell>
      <DeviceRegistryView
        identity={<AccountIdentityView person={person} accountId={accountId} />}
        signOut={
          <SignOutButtonView className={DEVICE_REGISTRY_SIGN_OUT_CLASS} />
        }
        banner={null}
      >
        <DeviceListView>
          {rows.map((row) => (
            <DevicesPageRowView
              key={row.deviceId}
              row={row}
              canForwardPorts={canForwardPorts}
              launchAtLoginSupported={launchAtLoginSupported}
            />
          ))}
        </DeviceListView>
      </DeviceRegistryView>
    </DevicesPageShell>
  );
}

function DevicesPageRowView({
  row,
  canForwardPorts,
  launchAtLoginSupported,
}: {
  row: DevicesPageRow;
  canForwardPorts: boolean;
  launchAtLoginSupported: boolean;
}) {
  const showId = row.showId ?? false;
  const access = row.access ?? GRANTED;
  const { controlLabel, hostsCached } = deviceRowFacts({
    deviceId: row.deviceId,
    platform: row.platform,
    isThisDevice: row.isThisDevice,
    name: row.name,
    showId,
    status: row.status,
  });
  return (
    <DeviceRegistryRowView
      deviceId={row.deviceId}
      platform={row.platform}
      isThisDevice={row.isThisDevice}
      name={row.name}
      showId={showId}
      status={row.status}
      appVersion={row.appVersion}
      tunnel={row.tunnel}
      access={access}
      canForwardPorts={canForwardPorts}
      renaming={false}
      confirming={false}
      revokePending={false}
      iconPicker={
        <DeviceIconPickerView
          icon={row.icon}
          tone={row.status.tone}
          label={controlLabel}
          detected={row.isThisDevice ? row.icon : undefined}
        />
      }
      nameField={
        <DeviceNameFieldView
          deviceName={row.name}
          label={controlLabel}
          editing={false}
          className="text-base"
        />
      }
      hosts={
        <DeviceHostsView
          chips={row.chips}
          loading={false}
          cached={hostsCached}
          renderIcon={(chip) => (
            <ProjectIconView
              name={chip.name}
              src={chip.iconSrc}
              className="size-3"
            />
          )}
        />
      }
      switches={
        <>
          <AcceptCommandsToggleView enabled={row.acceptsCommands} />
          <KeepReachableToggleView
            checked={row.keepReachable ?? false}
            launchAtLoginSupported={launchAtLoginSupported}
          />
        </>
      }
      portForwards={
        <PortForwardSectionView
          forwards={row.forwards ?? []}
          canStart={access.granted}
        />
      }
    />
  );
}
