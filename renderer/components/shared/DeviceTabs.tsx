// The device tab bar, and the body under it. Every page that shows one
// device's view of something several devices hold (a project's pages,
// the tidy page) leads its header with one tab per device and mounts
// its body under the picked device's HostScope, so the page needs no
// remote-awareness of its own. Each tab is the pill the worktree
// header marks a device with (DeviceChip, with its connection on the
// dot, which this device has no need of), the picked one in the accent fill
// every selection in the app wears. One row that scrolls sideways when
// the devices outnumber the width, never wrapping, so the title row
// below keeps its place however many machines there are. Left and
// right arrows move the pick, as tabs do. A page with something that
// belongs to the devices as a group (Configure's shared settings) leads
// the row with one tab for it, ahead of the machines it spans.
import { useState, type ReactNode } from "react";
import { MonitorSmartphone } from "lucide-react";
import type { DeviceKind } from "@shared/account/deviceKind";
import { DEVICE_PILL_CLASS } from "@/components/shared/DeviceChip";
import { DeviceGlyph } from "@/components/shared/DeviceIcon";
import { hostsProjects } from "@/lib/remote/deviceTraits";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { useLocalDevice } from "@/hooks/account/useAccount";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import {
  HostScopeProvider,
  LocalHostScope,
  type HostApi,
} from "@/hooks/remote/useHostScope";
import { useLastGoodApi } from "@/hooks/remote/useLastGoodApi";
import { useRovingPick } from "@/hooks/ui/useRovingPick";
import {
  useRemoteDevice,
  useRemoteDevices,
} from "@/hooks/remote/useRemoteDevices";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import {
  deviceStatusView,
  deviceTitle,
  type DeviceStatusView,
} from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";

export interface DeviceRosterEntry {
  deviceId: string;
  label: string;
  // What it looks like (DeviceIcon), so every pick draws it.
  kind: DeviceKind;
  isThisDevice: boolean;
  // Registers projects (deviceTraits): a browser on the account is a
  // device too, but hosts no forest.
  hostsProjects: boolean;
  // Null for this device, which has no connection to describe.
  status: DeviceStatusView | null;
  // The api the body is scoped to: window.api for this device, a
  // peer's only while it has a session.
  api: HostApi | undefined;
}

export interface DeviceTab extends DeviceRosterEntry {
  // Why the body can't be the page proper: the peer has no session, or
  // will not run commands from here. Undefined when it can.
  block: "offline" | "no-grant" | undefined;
}

// Every device on the account, in the one order every device pick
// uses: this device first (a hostless client has none), then the
// reachable peers, then the rest, so the machines that can answer sit
// where the eye starts. The tabs below layer the command grant on it;
// the sidebar's device filter reads it as is.
export function useDeviceRoster(): DeviceRosterEntry[] {
  const devices = useRemoteDevices();
  const local = useLocalDevice();
  const here: DeviceRosterEntry[] = hasLocalHost
    ? [
        {
          deviceId: localDeviceId,
          label: local.name,
          kind: local.kind,
          isThisDevice: true,
          hostsProjects: true,
          status: null,
          api: window.api,
        },
      ]
    : [];
  const peers = devices.map(
    (device): DeviceRosterEntry => ({
      deviceId: device.deviceId,
      label: device.label,
      kind: device.kind,
      isThisDevice: false,
      hostsProjects: hostsProjects(device.platform),
      status: deviceStatusView(device.status),
      api: device.api,
    }),
  );
  return [
    ...here,
    ...peers.filter((peer) => peer.status?.reachable),
    ...peers.filter((peer) => !peer.status?.reachable),
  ];
}

// The roster as tabs, each with why its body can't be the page.
// useDeviceTargets layers a repo's checkout per device on top of it. A
// peer is granted while its verdict is still in flight, the sidebar's
// rule, rather than flashing a refusal that turns into a body a moment
// later.
export function useDeviceTabs(): DeviceTab[] {
  const access = usePeerCommandAccess(useRemoteDevices());
  const tabs: DeviceTab[] = [];
  for (const entry of useDeviceRoster()) {
    const block = entry.isThisDevice
      ? undefined
      : !entry.status?.reachable || entry.api === undefined
        ? "offline"
        : commandAccessOf(access, entry.deviceId).canCommand
          ? undefined
          : "no-grant";
    tabs.push({ ...entry, block });
  }
  return tabs;
}

// The pick, opening on `initialId` (the device the route named) and
// falling back to it, then to the first tab, when the picked device
// leaves the list.
export function usePickedDevice<T extends DeviceTab>(
  tabs: readonly T[],
  initialId: string,
): [T | undefined, (deviceId: string) => void] {
  const [pickedId, setPickedId] = useState(initialId);
  const picked =
    tabs.find((tab) => tab.deviceId === pickedId) ??
    tabs.find((tab) => tab.deviceId === initialId) ??
    tabs[0];
  return [picked, setPickedId];
}

// The id the all-devices tab is picked by. Not a device id (those are
// UUIDs), so it can share onSelect with them.
export const ALL_DEVICES_TAB_ID = "all-devices";

export function DeviceTabBar({
  tabs,
  selectedId,
  onSelect,
  allDevicesTab = false,
  className,
}: {
  tabs: readonly DeviceTab[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
  // Leads the row with the tab for what every device shares, picked
  // as ALL_DEVICES_TAB_ID.
  allDevicesTab?: boolean;
  // Overrides the page inset for a bar that sits in a dialog instead.
  className?: string;
}) {
  // One list for the row, so the roving order and the rendered order
  // cannot disagree.
  const pills = [
    ...(allDevicesTab
      ? [
          {
            id: ALL_DEVICES_TAB_ID,
            title: "Settings every device shares",
            lead: <MonitorSmartphone className="size-3.5 shrink-0" />,
            label: "All devices",
          },
        ]
      : []),
    ...tabs.map((tab) => ({
      id: tab.deviceId,
      title: deviceTitle(tab.label, tab.status),
      // The device's connection dot, then its glyph: this device has
      // no connection to show and wears the glyph alone.
      lead: <DeviceGlyph kind={tab.kind} tone={tab.status?.tone} />,
      label: tab.label,
    })),
  ];
  const { listRef, onKeyDown } = useRovingPick({
    ids: pills.map((pill) => pill.id),
    selectedId,
    onSelect,
    pickedSelector: '[aria-selected="true"]',
  });

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Device"
      // The page inset as padding rather than the header's, so a long
      // row scrolls out under the header's edge (which cancels the
      // inset with a matching negative margin) instead of clipping.
      className={cn(
        "flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-6 phone:px-4",
        className,
      )}
    >
      {pills.map((pill) => {
        const selected = pill.id === selectedId;
        return (
          <button
            key={pill.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-slot="device-chip"
            title={pill.title}
            onClick={() => onSelect(pill.id)}
            onKeyDown={onKeyDown}
            className={cn(
              DEVICE_PILL_CLASS,
              "transition-colors",
              selected
                ? "border-transparent bg-accent text-accent-foreground"
                : "hover:text-foreground",
            )}
          >
            {pill.lead}
            <span className="max-w-40 truncate">{pill.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// The body under the picked tab: the page itself under that device's
// scope, or a note where the page can't be. An offline peer keeps its
// tab and says so, rather than vanishing and leaving "where did the
// Thinkpad go" open (where the page knows the peer at all: a project
// page lists a peer by its checkout, which an asleep peer never asked
// this session can't report). A peer that will not run commands from
// here says where the grant is made, since every page here exists to
// change something. `subject` is what the page is about, in the peer's
// possessive ("its copy of this project", "its forest"). Rendered at
// one tree position whether or not there is a choice yet, so a tab
// bar arriving after the body (the peers' answers land late) never
// remounts it.
export function DeviceTabPanel({
  tab,
  subject,
  children,
}: {
  tab: DeviceTab;
  subject: string;
  children: ReactNode;
}) {
  // This device is re-pinned rather than left to the surrounding
  // scope: under a peer's /devices route the page already sits in that
  // peer's scope, and its "this device" tab must not. Keyed per device
  // either way: a body seeds from the picked device's own answers, so
  // carrying state across would show one device's data under another's.
  // The peer's last api survives a session blip so the body under it
  // (a form and its unsaved edits) stays mounted, and the offline note
  // moves above it. A peer never reached in this window has nothing to
  // show and gets the note alone.
  const kept = useLastGoodApi(useRemoteDevice(tab.deviceId));
  if (tab.isThisDevice) {
    return <LocalHostScope key={tab.deviceId}>{children}</LocalHostScope>;
  }
  const offline = tab.api === undefined || tab.block === "offline";
  const note = offline
    ? `${tab.label} is offline, and ${subject} loads when it reconnects.`
    : tab.block === "no-grant"
      ? peerReadOnlyNote(tab.label)
      : null;
  if (note !== null && (!offline || kept === undefined)) {
    return (
      <div className="p-6 phone:p-4">
        <EmptyPanel>{note}</EmptyPanel>
      </div>
    );
  }
  const api = tab.api ?? kept;
  if (api === undefined) return null;
  return (
    <HostScopeProvider key={tab.deviceId} deviceId={tab.deviceId} api={api}>
      {offline && (
        <p className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
          {note} Showing the last state it sent.
        </p>
      )}
      {children}
    </HostScopeProvider>
  );
}
