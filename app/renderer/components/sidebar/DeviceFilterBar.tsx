// The device filter above the forest, in both views (its look is
// DeviceFilterBarView): picking a machine narrows both views to that
// machine's worktrees. It draws only while there is more than one
// machine to choose from. A forest with nothing to narrow has no bar.
import { useRovingPick } from "@/hooks/ui/useRovingPick";
import { setDeviceFilter, type DeviceFilter } from "./deviceFilter";
import {
  ALL_DEVICES,
  DeviceFilterBarView,
  devicePillIds,
} from "./DeviceFilterBarView";

const pick = (id: string) => setDeviceFilter(id === ALL_DEVICES ? null : id);

export function DeviceFilterBar({ choices, selected }: DeviceFilter) {
  const selectedId = selected?.deviceId ?? ALL_DEVICES;
  const { listRef, onKeyDown } = useRovingPick({
    ids: devicePillIds(choices),
    selectedId,
    onSelect: pick,
    pickedSelector: '[aria-checked="true"]',
  });
  return (
    <DeviceFilterBarView
      choices={choices}
      selectedId={selectedId}
      onPick={pick}
      listRef={listRef}
      onKeyDown={onKeyDown}
    />
  );
}
