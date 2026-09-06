// The device tab bar, and the body under it. Every page that shows one
// device's view of something several devices hold (a project's pages,
// the tidy page) leads its header with one tab per device and mounts
// its body under the picked device's HostScope, so the page needs no
// remote-awareness of its own. Each tab is the pill the worktree
// header marks a device with (DeviceChip; its connection on the dot,
// this device has none to report), the picked one in the accent fill
// every selection in the app wears. One row that scrolls sideways when
// the devices outnumber the width, never wrapping, so the title row
// below keeps its place however many machines there are. Left and
// right arrows move the pick, as tabs do.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEVICE_PILL_CLASS } from "@/components/remote/DeviceChip";
import { EmptyPanel } from "@/components/remote/EmptyPanel";
import { StatusDot } from "@/components/ui/status-dot";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import {
  commandAccessOf,
  usePeerCommandAccess,
} from "@/hooks/remote/useCommandAccess";
import { MaybeHostScope, type HostApi } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import {
  deviceStatusView,
  type DeviceStatusView,
} from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";

export interface DeviceTab {
  deviceId: string;
  label: string;
  isThisDevice: boolean;
  // Null for this device, which has no connection to describe.
  status: DeviceStatusView | null;
  // The api the body is scoped to: window.api for this device, a
  // peer's only while it has a session.
  api: HostApi | undefined;
  // Why the body can't be the page proper: the peer has no session, or
  // will not run commands from here. Undefined when it can.
  block: "offline" | "no-grant" | undefined;
}

// Every device on the account as a tab: this device first (a hostless
// client has none), then the reachable peers, then the rest, so the
// machines that can answer sit where the eye starts. The one list
// behind every device pick; useDeviceTargets layers a repo's checkout
// per device on top of it. A peer is granted while its verdict is
// still in flight, the sidebar's rule, rather than flashing a refusal
// that turns into a body a moment later.
export function useDeviceTabs(): DeviceTab[] {
  const devices = useRemoteDevices();
  const access = usePeerCommandAccess(devices);
  const localName = useLocalDeviceName();
  const here: DeviceTab[] = hasLocalHost
    ? [
        {
          deviceId: localDeviceId,
          label: localName,
          isThisDevice: true,
          status: null,
          api: window.api,
          block: undefined,
        },
      ]
    : [];
  const peers = devices.map((device): DeviceTab => {
    const status = deviceStatusView(device.status);
    return {
      deviceId: device.deviceId,
      label: device.label,
      isThisDevice: false,
      status,
      api: device.api,
      block:
        !status.reachable || device.api === undefined
          ? "offline"
          : commandAccessOf(access, device.deviceId).canCommand
            ? undefined
            : "no-grant",
    };
  });
  return [
    ...here,
    ...peers.filter((tab) => tab.block !== "offline"),
    ...peers.filter((tab) => tab.block === "offline"),
  ];
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

// Brings the picked tab into view within the row alone (not
// scrollIntoView, which would also pull every scrolling ancestor), by
// the row's own inset.
function reveal(list: HTMLElement) {
  const tab = list.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!tab) return;
  const inset = parseFloat(getComputedStyle(list).paddingLeft) || 0;
  const edge = list.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  if (box.left < edge.left + inset) {
    list.scrollLeft += box.left - (edge.left + inset);
  } else if (box.right > edge.right - inset) {
    list.scrollLeft += box.right - (edge.right - inset);
  }
}

export function DeviceTabBar({
  tabs,
  selectedId,
  onSelect,
}: {
  tabs: readonly DeviceTab[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // On a pick: a route that opens on the last of many devices, or an
  // arrow key walking past the edge.
  useEffect(() => {
    if (listRef.current) reveal(listRef.current);
  }, [selectedId]);
  // And when the row itself changes width: a window narrowed after
  // the pick.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => reveal(list));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // On the tabs themselves (the focusable ones, by roving tabindex),
  // so the bar needs no focus stop of its own.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.deviceId === selectedId);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next === undefined) return;
    onSelect(next.deviceId);
    // Focus follows the pick once the new tab is the focusable one.
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus();
    });
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Device"
      // The page inset as padding rather than the header's, so a long
      // row scrolls out under the header's edge (which cancels the
      // inset with a matching negative margin) instead of clipping.
      className="flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-6 phone:px-4"
    >
      {tabs.map((tab) => {
        const selected = tab.deviceId === selectedId;
        return (
          <button
            key={tab.deviceId}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-slot="device-chip"
            title={
              tab.isThisDevice
                ? "This device"
                : `${tab.label} (${tab.status?.label})`
            }
            onClick={() => onSelect(tab.deviceId)}
            onKeyDown={onKeyDown}
            className={cn(
              DEVICE_PILL_CLASS,
              "transition-colors",
              selected
                ? "border-transparent bg-accent text-accent-foreground"
                : "hover:text-foreground",
            )}
          >
            {tab.status && <StatusDot tone={tab.status.tone} />}
            <span className="max-w-40 truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// The body under the picked tab: the page itself under that device's
// scope, or a note where the page can't be. An offline peer keeps its
// tab and says so, rather than vanishing and leaving "where did the
// Thinkpad go" open; a peer that will not run commands from here says
// where the grant is made, since every page here exists to change
// something. `subject` is what the page is about, in the peer's
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
  const note =
    tab.block === "offline" || (!tab.isThisDevice && tab.api === undefined)
      ? `${tab.label} is offline, and ${subject} loads when it reconnects.`
      : tab.block === "no-grant"
        ? peerReadOnlyNote(tab.label)
        : null;
  if (note !== null) {
    return (
      <div className="p-6">
        <EmptyPanel>{note}</EmptyPanel>
      </div>
    );
  }
  // Keyed per device: a body seeds from the picked device's own
  // answers, so carrying state across would show one device's data
  // under another's. This device gets no provider at all, the default
  // scope being its own.
  return (
    <MaybeHostScope key={tab.deviceId} deviceId={tab.deviceId} api={tab.api}>
      {children}
    </MaybeHostScope>
  );
}
