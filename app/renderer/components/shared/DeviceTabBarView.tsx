// The device tab bar (DeviceTabs.tsx has the pick and the body under
// it): one tab per device, each the pill the worktree header marks a
// device with (DeviceChipView, with its connection on the dot, which
// this device has no need of), the picked one in the accent fill every
// selection in the app wears. One row that scrolls sideways when the
// devices outnumber the width, never wrapping, so the title row below
// keeps its place however many machines there are. Left and right
// arrows move the pick, as tabs do. A page with something that belongs
// to the devices as a group (Configure's shared settings) leads the row
// with one tab for it, ahead of the machines it spans.
import { Fragment, type ReactNode } from "react";
import { ArrowRight, MonitorSmartphone } from "lucide-react";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DEVICE_PILL_CLASS } from "@/components/shared/DeviceChipView";
import { DeviceLeadView } from "@/components/shared/DeviceGlyphView";
import { EmptyPanel } from "@/components/ui/empty-panel";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useRovingPick } from "@/hooks/ui/useRovingPick";
import type { DeviceStatusView } from "@/lib/remote/deviceStatus";
import { cn, dragRegion } from "@/lib/utils";

// The id the all-devices tab is picked by. Not a device id (those are
// UUIDs), so it can share onSelect with them.
export const ALL_DEVICES_TAB_ID = "all-devices";

// What the bar draws of a device: a roster entry, plus what a page
// may say about it beyond its name.
export type DeviceBarTab = {
  deviceId: string;
  label: string;
  icon: DeviceIcon;
  // Null for this device, which has no connection to describe.
  status: DeviceStatusView | null;
  // A word after the name (a mirror's "original" and "copy").
  note?: string;
  // An arrow ahead of the pill, from the tab before it (a mirror's
  // original to its copy).
  arrowBefore?: boolean;
  // A mark after the name (Settings' UpdateMark on a device holding a
  // staged update).
  badge?: ReactNode;
};

export function DeviceTabBarView({
  tabs,
  selectedId,
  onSelect,
  allDevicesTab = false,
  trailing,
  className,
}: {
  tabs: readonly DeviceBarTab[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
  // Leads the row with the tab for what every device shares, picked
  // as ALL_DEVICES_TAB_ID.
  allDevicesTab?: boolean;
  // An action for every tab at once (Settings' Update all), after the
  // last tab in the same scrolling row, so it never covers one. It
  // keeps to the row's end while the tabs leave room, and takes their
  // height.
  trailing?: ReactNode;
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
            lead: <MonitorSmartphone className="size-3.5 shrink-0" />,
            label: "All devices",
            note: undefined,
            arrowBefore: false,
            badge: undefined,
          },
        ]
      : []),
    ...tabs.map((tab) => ({
      id: tab.deviceId,
      // The device's connection dot, then its glyph: this device has
      // no connection to show and wears the glyph alone.
      lead: <DeviceLeadView icon={tab.icon} tone={tab.status?.tone} />,
      label: tab.label,
      note: tab.note,
      arrowBefore: tab.arrowBefore === true,
      badge: tab.badge,
    })),
  ];
  const { listRef, onKeyDown } = useRovingPick({
    ids: pills.map((pill) => pill.id),
    selectedId,
    onSelect,
    pickedSelector: '[aria-selected="true"]',
  });

  // The row scrolls as one, a trailing action with it, while only the
  // tabs are the tablist. The page inset is padding rather than the
  // header's, so a long row scrolls out under the header's edge (which
  // cancels the inset with a matching negative margin) instead of
  // clipping.
  return (
    <div
      ref={listRef}
      className={cn(
        "flex [scrollbar-width:none] items-center gap-1.5 overflow-x-auto px-6 phone:px-4",
        className,
      )}
    >
      <div
        role="tablist"
        aria-label="Device"
        className="flex items-center gap-1.5"
      >
        {pills.map((pill) => {
          const selected = pill.id === selectedId;
          return (
            <Fragment key={pill.id}>
              {pill.arrowBefore && (
                <ArrowRight
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-slot="device-chip"
                onClick={() => onSelect(pill.id)}
                onKeyDown={onKeyDown}
                // A page header puts the row under the window's drag strip
                // (AppShell): each pill carves its own click out of it.
                style={dragRegion("no-drag")}
                className={cn(
                  DEVICE_PILL_CLASS,
                  "transition-colors",
                  selected
                    ? "border-transparent bg-accent text-accent-foreground"
                    : "hover:text-foreground",
                )}
              >
                {pill.lead}
                <SimpleTooltip whenTruncated tip={pill.label}>
                  <span className="max-w-40 truncate">{pill.label}</span>
                </SimpleTooltip>
                {pill.note !== undefined && (
                  <span
                    className={cn(
                      "text-2xs",
                      selected ? "opacity-70" : "text-muted-foreground/70",
                    )}
                  >
                    {pill.note}
                  </span>
                )}
                {pill.badge}
              </button>
            </Fragment>
          );
        })}
      </div>
      {trailing !== undefined && (
        // Under the drag strip like the pills (AppShell).
        <div
          style={dragRegion("no-drag")}
          className="ml-auto flex shrink-0 self-stretch"
        >
          {trailing}
        </div>
      )}
    </div>
  );
}

// What stands in for the body under a peer's tab while the page can't
// be (DeviceTabPanel): offline, or not running commands from here.
export function DeviceTabNoteView({ note }: { note: string }) {
  return (
    <div className="p-6 phone:p-4">
      <EmptyPanel>{note}</EmptyPanel>
    </div>
  );
}

// Over a body kept from an offline peer's last answers.
export function StaleDeviceNoteView({ note }: { note: string }) {
  return (
    <p className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
      {note} Showing the last state it sent.
    </p>
  );
}
