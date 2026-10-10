// The account page over the fixtures: Studio Mac signed in with its
// three peers, one forwarding a port and one asleep, and the page's
// other states, with a peer's pages when it cannot be reached.
import type { ReactNode } from "react";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import {
  SignInButtonView,
  SignOutButtonView,
} from "../views/account/AccountButtonsView.tsx";
import { PageShellView } from "../views/shared/PageShellView.tsx";
import { ProjectIconView } from "../views/shared/ProjectIconView.tsx";
import { AcceptCommandsToggleView } from "../views/remote/AcceptCommandsToggleView.tsx";
import {
  AccountLoadingView,
  NotConfiguredPanelView,
  SignedOutPanelView,
} from "../views/remote/AccountPanelsView.tsx";
import { DeviceHostsView } from "../views/remote/DeviceHostsView.tsx";
import { DeviceIconPickerView } from "../views/remote/DeviceIconPickerView.tsx";
import { DeviceNameFieldView } from "../views/remote/DeviceNameFieldView.tsx";
import {
  deviceRowLabels,
  DeviceRegistryRowView,
  ExposureSwitchesView,
} from "../views/remote/DeviceRegistryRowView.tsx";
import {
  AccountIdentityView,
  DeviceRegistryView,
  SignInBannerView,
} from "../views/remote/DeviceRegistryView.tsx";
import { KeepReachableToggleView } from "../views/remote/KeepReachableToggleView.tsx";
import { NotSharingView } from "../views/remote/NotSharingView.tsx";
import { PortForwardSectionView } from "../views/remote/PortForwardSectionView.tsx";
import {
  OpenDevicesButtonView,
  RemoteScopeFrameView,
  UnreachableBannerView,
  UnreachableDeviceView,
} from "../views/remote/RemoteScopeView.tsx";
import { ShareDataToggleView } from "../views/remote/ShareDataToggleView.tsx";
import { deviceRowStatus } from "../views/remote/deviceRegistryStatus.ts";
import {
  accountDevices,
  forests,
  LOCAL_DEVICE_ID,
  THINKPAD_ID,
} from "../fixtures/fixtures.ts";
import { SceneWindowFrame } from "./frame.tsx";
import { SceneSidebar } from "./sidebar.tsx";
import { deviceById, projectIconSrc } from "./world.ts";

const noop = () => {};
const ACCOUNT_ID = "user_2rin8xk3";
const GRANTED = { granted: true, isLoading: false, canCommand: true };
const REFUSED = { granted: false, isLoading: false, canCommand: false };

// A device's projects as the row's chips, each with its icon.
function hostChips(deviceId: string) {
  const forest = forests[deviceId];
  return (forest?.projects ?? []).map((project) => ({
    projectId: project.id,
    name: project.name,
    worktrees: forest?.worktrees[project.id]?.length ?? 0,
    icon: (
      <ProjectIconView
        src={projectIconSrc(project.name)}
        name={project.name}
        className="size-3"
      />
    ),
  }));
}

function row(
  device: DeviceInfo,
  {
    renaming = false,
    confirming = false,
    exposure = null,
    showId = false,
    access = GRANTED,
  }: {
    renaming?: boolean;
    confirming?: boolean;
    exposure?: ReactNode;
    showId?: boolean;
    access?: typeof GRANTED;
  } = {},
) {
  const isThisDevice = device.deviceId === LOCAL_DEVICE_ID;
  // The registry's own reading: this machine's socket, a peer's
  // session, or when it was last seen.
  const status =
    !isThisDevice && device.online
      ? deviceById(device.deviceId).status
      : deviceRowStatus(device, isThisDevice, undefined, null, Date.now());
  const icon = device.icon ?? "desktop";
  const { controlLabel } = deviceRowLabels({
    device,
    isThisDevice,
    name: device.name,
    showId,
  });
  return (
    <DeviceRegistryRowView
      key={device.deviceId}
      device={device}
      isThisDevice={isThisDevice}
      name={device.name}
      showId={showId}
      status={status}
      appVersion={status.reachable || isThisDevice ? "2.0.3" : ""}
      tunnel={isThisDevice ? "up" : undefined}
      access={access}
      renaming={renaming}
      confirming={confirming}
      revokePending={false}
      onRename={noop}
      onRemove={noop}
      onCancelRemove={noop}
      iconPicker={
        <DeviceIconPickerView
          icon={icon}
          tone={status.tone}
          label={controlLabel}
          detected={isThisDevice ? icon : undefined}
          disabled={false}
          onPick={noop}
        />
      }
      nameField={
        <DeviceNameFieldView
          deviceName={device.name}
          label={controlLabel}
          editing={renaming}
          onEditingChange={noop}
          pending={false}
          onRename={noop}
          className="text-base"
        />
      }
      hosts={
        <DeviceHostsView
          chips={hostChips(device.deviceId)}
          loading={false}
          cached={!isThisDevice && !status.reachable}
        />
      }
      exposure={exposure}
    />
  );
}

const [HERE, THINKPAD, MINI, WORKPC] = accountDevices;

// The Thinkpad's dev server, forwarded here.
const FORWARD = {
  forwardId: "fwd_1",
  deviceId: THINKPAD_ID,
  localPort: 5741,
  remotePort: 5173,
  connCount: 2,
};

function registry(rows: ReactNode[], banner: ReactNode = null) {
  return (
    <DeviceRegistryView
      account={
        <AccountIdentityView person="rin@forest.dev" accountId={ACCOUNT_ID} />
      }
      signOut={
        <SignOutButtonView
          pending={false}
          onClick={noop}
          className="-my-1 text-muted-foreground"
        />
      }
      banner={banner}
      list={{ state: "ready", rows }}
    />
  );
}

const signIn = (
  <SignInButtonView retry={false} pending={false} onClick={noop} />
);

// The account page, signed in: this machine sharing and taking control
// from the others, the Thinkpad with a forward open, the Mini asleep.
export function DevicesPageScene() {
  return (
    <SceneWindowFrame sidebar={<SceneSidebar view="inbox" />}>
      <PageShellView
        page="devices"
        eyebrow="Settings"
        title="Account"
        watermark="アカウント"
      >
        {registry(
          [HERE, THINKPAD, MINI, WORKPC].flatMap((device) =>
            device === undefined
              ? []
              : [
                  row(device, {
                    exposure:
                      device === HERE ? (
                        <ExposureSwitchesView>
                          <ShareDataToggleView
                            on
                            disabled={false}
                            onChange={noop}
                          />
                          <AcceptCommandsToggleView
                            enabled
                            isError={false}
                            pending={false}
                            onChange={noop}
                          />
                          <KeepReachableToggleView
                            on
                            pending={false}
                            onChange={noop}
                            launchAtLogin
                          />
                        </ExposureSwitchesView>
                      ) : device === THINKPAD ? (
                        <PortForwardSectionView
                          canStart
                          forwards={[FORWARD]}
                          startPending={false}
                          onStart={noop}
                          stopPending={false}
                          onStop={noop}
                        />
                      ) : null,
                  }),
                ],
          ),
        )}
      </PageShellView>
    </SceneWindowFrame>
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

// The page's other states: before sign-in, a build with no account
// service, a removed device signing back in, a rename and a removal
// under way, this machine not taking control, and a peer that cannot
// be reached.
export function DevicesPartsScene() {
  const mini = deviceById(MINI?.deviceId ?? "");
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex min-w-0 flex-col gap-5">
        <Part label="Loading">
          <AccountLoadingView />
          <DeviceRegistryView
            account={
              <AccountIdentityView person={null} accountId={ACCOUNT_ID} />
            }
            signOut={null}
            banner={null}
            list={{ state: "loading" }}
          />
        </Part>
        <Part label="Signed out">
          <SignedOutPanelView desktop signIn={signIn} />
        </Part>
        <Part label="No account service">
          <NotConfiguredPanelView isDev desktop />
        </Part>
        <Part label="Removed, and the list refused">
          <DeviceRegistryView
            account={
              <AccountIdentityView
                person="rin@forest.dev"
                accountId={ACCOUNT_ID}
              />
            }
            signOut={null}
            banner={
              <SignInBannerView
                signIn={<SignInButtonView retry pending onClick={noop} />}
              >
                This device was removed from the account, so it is signing out.
              </SignInBannerView>
            }
            list={{
              state: "failed",
              message:
                "The device hub refused this request, so the device list is unavailable.",
            }}
          />
        </Part>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Part label="Renaming, removing, and not taking control">
          <ul className="divide-y divide-border">
            {HERE &&
              row(HERE, {
                renaming: true,
                exposure: (
                  <ExposureSwitchesView>
                    <ShareDataToggleView
                      on={false}
                      disabled={false}
                      onChange={noop}
                    />
                    <KeepReachableToggleView
                      on={false}
                      pending={false}
                      onChange={noop}
                      launchAtLogin={false}
                    />
                  </ExposureSwitchesView>
                ),
              })}
            {WORKPC && row(WORKPC, { confirming: true, showId: true })}
            {THINKPAD &&
              row(THINKPAD, {
                access: REFUSED,
                exposure: (
                  <PortForwardSectionView
                    canStart={false}
                    forwards={[FORWARD]}
                    startPending={false}
                    onStart={noop}
                    stopPending={false}
                    onStop={noop}
                  />
                ),
              })}
          </ul>
        </Part>
        <Part label="Control, before its first read">
          <AcceptCommandsToggleView
            enabled={undefined}
            isError={false}
            pending={false}
            onChange={noop}
          />
        </Part>
        <Part label="A peer that can't be reached">
          <div className="h-24 overflow-hidden rounded-lg border border-border">
            <RemoteScopeFrameView
              banner={
                <UnreachableBannerView
                  label={`${mini.label} is ${mini.status.label.toLowerCase()}.`}
                  action={<OpenDevicesButtonView desktop onClick={noop} />}
                />
              }
            >
              <p className="p-4 text-sm">The last state Mini sent.</p>
            </RemoteScopeFrameView>
          </div>
          <div className="h-32">
            <UnreachableDeviceView
              label="This device isn't in the account's registry."
              action={<OpenDevicesButtonView desktop={false} onClick={noop} />}
            />
          </div>
          <div className="h-32">
            <NotSharingView
              label={mini.label}
              action={<OpenDevicesButtonView desktop onClick={noop} />}
            />
          </div>
        </Part>
      </div>
    </div>
  );
}
