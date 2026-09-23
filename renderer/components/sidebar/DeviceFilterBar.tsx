// The device filter above the forest, in both views: one pill per
// machine on the account, and All. Picking one narrows both views to
// that machine's worktrees. It draws only while there is more than one
// machine to choose from. A forest with nothing to narrow has no bar.
//
// Each pill is the outline button the New worktree button above it is,
// so the row reads as one set of controls with it rather than a second
// kind of chip. Pills carry the device's glyph, the same one its rows
// carry (DeviceBadge), so the bar stays one row however many machines
// there are, and the picked pill spells its name out, so the narrowed
// forest always says which machine it is showing. A radio group: one
// pick at a time, arrows move it, the way the device tabs do.
import type { DeviceKind } from "@shared/account/deviceKind";
import { DeviceGlyph } from "@/components/shared/DeviceIcon";
import type { DeviceRosterEntry } from "@/components/shared/DeviceTabs";
import { Button } from "@/components/ui/button";
import { useRovingPick } from "@/hooks/ui/useRovingPick";
import { deviceTitle } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";
import { setDeviceFilter, type DeviceFilter } from "./deviceFilter";

const ALL = "all";

function pillFor(choice: DeviceRosterEntry, checked: boolean) {
  return {
    id: choice.deviceId,
    kind: choice.kind as DeviceKind | null,
    label: checked ? choice.label : null,
    title: deviceTitle(choice.label, choice.status),
    tone: choice.status?.tone ?? null,
  };
}

export function DeviceFilterBar({ choices, selected }: DeviceFilter) {
  const selectedId = selected?.deviceId ?? ALL;
  const pills = [
    { id: ALL, kind: null, label: "All", title: "Every device", tone: null },
    ...choices.map((choice) => pillFor(choice, choice.deviceId === selectedId)),
  ];
  const pick = (id: string) => setDeviceFilter(id === ALL ? null : id);
  const { listRef, onKeyDown } = useRovingPick({
    ids: pills.map((pill) => pill.id),
    selectedId,
    onSelect: pick,
    pickedSelector: '[aria-checked="true"]',
  });
  // One machine is nothing to filter by.
  if (choices.length < 2) return null;

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
            onClick={() => pick(pill.id)}
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
            {pill.kind && <DeviceGlyph kind={pill.kind} tone={pill.tone} />}
            {pill.label !== null && (
              <span className="max-w-32 truncate">{pill.label}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
