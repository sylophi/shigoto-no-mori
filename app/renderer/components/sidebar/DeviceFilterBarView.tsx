// The device filter's look (DeviceFilterBar keeps the pick): one pill
// per machine on the account, and All.
//
// Each pill is the outline button the New worktree button below it is,
// so the row reads as one set of controls with it rather than a second
// kind of chip. Each pill leads with the device's dot and glyph like
// every device row, then its two-letter mark (deviceAbbrev), so the
// bar stays one row however many machines there are, and the picked
// pill spells its name out, so the narrowed forest always says which
// machine it is showing. A radio group: one pick at a time, arrows
// move it, the way the device tabs do.
import type { KeyboardEvent, Ref } from "react";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { DeviceLead } from "@/components/shared/DeviceGlyph";
import { Button } from "@/components/ui/button";
import type { StatusTone } from "@/components/ui/status-dot";
import { deviceAbbrev } from "@/lib/deviceAbbrev";
import { deviceTitle, type DeviceStatusView } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";

export const ALL_DEVICES = "all";

// A machine the forest can be narrowed to, as the bar draws it (the
// roster's entry, DeviceRosterEntry, carries this and more).
export interface DeviceFilterChoice {
  deviceId: string;
  label: string;
  icon: DeviceIcon;
  // Null for this device, which has no connection to describe.
  status: DeviceStatusView | null;
}

// One pill: a device, or the All pill, which has no glyph and no tone.
type Pill = {
  id: string;
  icon: DeviceIcon | null;
  label: string;
  title: string;
  tone: StatusTone | null;
};

function pillFor(choice: DeviceFilterChoice, checked: boolean): Pill {
  return {
    id: choice.deviceId,
    icon: choice.icon,
    label: checked ? choice.label : deviceAbbrev(choice.label),
    title: deviceTitle(choice.label, choice.status),
    tone: choice.status?.tone ?? null,
  };
}

// The pills' ids in order, All first, for the roving pick.
export function devicePillIds(
  choices: readonly DeviceFilterChoice[],
): string[] {
  return [ALL_DEVICES, ...choices.map((choice) => choice.deviceId)];
}

export function DeviceFilterBarView({
  choices,
  selectedId,
  onPick,
  listRef,
  onKeyDown,
}: {
  choices: readonly DeviceFilterChoice[];
  // The picked pill's id, ALL_DEVICES for All.
  selectedId: string;
  onPick?: (id: string) => void;
  // The roving pick's (useRovingPick), which a live bar wires up.
  listRef?: Ref<HTMLDivElement>;
  onKeyDown?: (event: KeyboardEvent) => void;
}) {
  // One machine is nothing to filter by.
  if (choices.length < 2) return null;
  const pills: Pill[] = [
    {
      id: ALL_DEVICES,
      icon: null,
      label: "All",
      title: "Every device",
      tone: null,
    },
    ...choices.map((choice) => pillFor(choice, choice.deviceId === selectedId)),
  ];

  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label="Show worktrees on"
      data-slot="sidebar-device-filter"
      // Scrolls sideways past the edge rather than wrapping, so the
      // list below keeps its place however many machines there are.
      className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto px-2 pb-1.5"
    >
      {pills.map((pill) => {
        const checked = pill.id === selectedId;
        return (
          <Button
            key={pill.id}
            variant="outline"
            size="xs"
            role="radio"
            aria-checked={checked}
            aria-label={pill.title}
            tabIndex={checked ? 0 : -1}
            title={pill.title}
            onClick={() => onPick?.(pill.id)}
            onKeyDown={onKeyDown}
            // The picked pill wears the accent fill every selection in
            // the app wears, hover included, over the variant's own
            // fill. (doubutsu fills outline buttons from an unlayered
            // rule, so it re-fills the picked pill itself: see
            // sidebar-device-filter.)
            className={cn(
              "font-normal",
              checked &&
                "border-transparent bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {pill.icon && (
              <DeviceLead icon={pill.icon} tone={pill.tone} size="xs" />
            )}
            <span className="max-w-32 truncate">{pill.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
