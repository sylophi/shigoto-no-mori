// The device filter above the forest (DeviceFilterBarView), narrowing
// both views to the picked machine.
import { ALL_DEVICES, DeviceFilterBarView } from "./DeviceFilterBarView";
import { setDeviceFilter, type DeviceFilter } from "./deviceFilter";

export function DeviceFilterBar({ choices, selected }: DeviceFilter) {
  return (
    <DeviceFilterBarView
      choices={choices}
      selectedId={selected?.deviceId ?? ALL_DEVICES}
      onPick={setDeviceFilter}
    />
  );
}
