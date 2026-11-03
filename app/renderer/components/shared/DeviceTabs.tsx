// The device tabs' pick, and the body under it. Every page that shows
// one device's view of something several devices hold (a project's
// pages, the tidy page) leads its header with one tab per device
// (DeviceTabBarView) and mounts its body under the picked device's
// HostScope, so the page needs no remote-awareness of its own.
import { capitalized } from "@shigomori/contracts/words";
import { useState, type ReactNode } from "react";
import {
  DeviceTabNoteView,
  StaleDeviceNoteView,
} from "@shigomori/ui/views/shared/DeviceTabBarView.tsx";
import { DeviceScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useHostDevices } from "@/hooks/remote/useDevices";
import { peerReadOnlyNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { commandAccessOf, liveApi, statusViewOf } from "@/lib/remote/devices";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import type { DeviceRosterEntry as ViewRosterEntry } from "@shigomori/ui/lib/deviceRoster.ts";
import { useApi } from "@/lib/runtime/pageApi";

export interface DeviceRosterEntry extends ViewRosterEntry {
  // The api the body is scoped to: the page's api for this device, a
  // peer's only while it has a session.
  api: HostApi | undefined;
}

export interface DeviceTab extends DeviceRosterEntry {
  // Why the body can't be the page proper: the peer has no session, or
  // will not run commands from here. Undefined when it can.
  block: "offline" | "no-grant" | undefined;
}

const leads = (entry: DeviceRosterEntry) =>
  entry.isThisDevice || entry.status?.reachable === true;

// Every machine on the account, in the one order every device pick
// uses: this device first (a hostless client has none), then the
// reachable peers, then the rest, so the machines that can answer sit
// where the eye starts. A browser on the account is a device too, but
// hosts no forest, so no pick offers it. The tabs below layer the
// command grant on it, and the sidebar's device filter reads it as is.
export function useDeviceRoster(): DeviceRosterEntry[] {
  const page = useApi();
  const entries = useHostDevices().map((device): DeviceRosterEntry => ({
    deviceId: device.deviceId,
    label: device.label,
    icon: device.icon,
    isThisDevice: device.isThisDevice,
    status: statusViewOf(device),
    api: liveApi(page, device),
  }));
  return [
    ...entries.filter(leads),
    ...entries.filter((entry) => !leads(entry)),
  ];
}

// The roster as tabs, each with why its body can't be the page.
// useDeviceTargets layers a repo's checkout per device on top of it. A
// peer is granted while its verdict is still in flight, the sidebar's
// rule, rather than flashing a refusal that turns into a body a moment
// later.
export function useDeviceTabs(): DeviceTab[] {
  const devices = useHostDevices();
  const tabs: DeviceTab[] = [];
  for (const entry of useDeviceRoster()) {
    const block = entry.isThisDevice
      ? undefined
      : !entry.status?.reachable
        ? "offline"
        : commandAccessOf(
              devices.find((device) => device.deviceId === entry.deviceId),
            ).canCommand
          ? undefined
          : "no-grant";
    tabs.push({ ...entry, block });
  }
  return tabs;
}

// The tab `pickedId` names, falling back to `initialId`, then to the
// first tab, when the picked device leaves the list. Undefined only
// while there are no tabs.
function resolvePick<T extends { deviceId: string }>(
  tabs: readonly T[],
  pickedId: string,
  initialId: string,
): T | undefined {
  return (
    tabs.find((tab) => tab.deviceId === pickedId) ??
    tabs.find((tab) => tab.deviceId === initialId) ??
    tabs[0]
  );
}

// The pick, opening on `initialId` (the device the route named).
export function usePickedDevice<T extends DeviceTab>(
  tabs: readonly T[],
  initialId: string,
): [T | undefined, (deviceId: string) => void] {
  const [pickedId, setPickedId] = useState(initialId);
  return [resolvePick(tabs, pickedId, initialId), setPickedId];
}

// One pick shared by the pages about a whole machine (Settings' host
// sections and Tidy), so stepping between them stays on the machine
// being looked at. Module state on purpose, like Settings' own
// section pick: a navigation nicety for this window's lifetime. It
// opens on this device (null until something else is picked). A
// remembered peer that has left falls back like any pick, while the raw
// pick stays, so a peer merely not rostered YET takes over the moment
// it appears.
const hostPick = createExternalStore<string | null>(null);

export function pickHostDevice(deviceId: string): void {
  if (hostPick.get() === deviceId) return;
  hostPick.publish(deviceId);
}

export function useHostDevicePick<T extends { deviceId: string }>(
  tabs: readonly T[],
): T | undefined {
  const localDeviceId = useApi().deviceId;
  const pick = useExternalStore(hostPick) ?? localDeviceId;
  return resolvePick(tabs, pick, localDeviceId);
}

// The body under the picked tab: the page itself under that device's
// scope, or a note where the page can't be. An offline peer keeps its
// tab and says so, rather than vanishing and leaving "where did the
// MacBook go" open (where the page knows the peer at all: a project
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
  // Every tab is scoped, this device's too: under a peer's /devices
  // route the page already sits in that peer's scope, and its "this
  // device" tab must not. Keyed per device: a body seeds from the picked
  // device's own answers, so carrying state across would show one
  // device's data under another's. An offline peer's body stays through
  // the blip (DeviceScope) with the note above it. One that couldn't be
  // asked since the panel opened on it has nothing to show and gets the
  // note alone.
  const offline = tab.block === "offline";
  const offlineNote = `${capitalized(tab.label)} is offline, and ${subject} loads when it reconnects.`;
  return (
    <DeviceScope
      key={tab.deviceId}
      deviceId={tab.deviceId}
      absent={offline ? <DeviceTabNoteView note={offlineNote} /> : undefined}
    >
      {offline && <StaleDeviceNoteView note={offlineNote} />}
      {tab.block === "no-grant" ? (
        <DeviceTabNoteView note={peerReadOnlyNote(tab.label)} />
      ) : (
        children
      )}
    </DeviceScope>
  );
}
