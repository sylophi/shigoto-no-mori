import { useEffect, useState } from "react";
import { useClientConfig } from "../config/useClientConfig";

// Keeps `.battery-saver` on <html> while this machine runs on battery
// and the user has not switched the pause off. doubutsu.css pauses the
// wallpaper drift under it the same way it does under `.unfocused`
// (boot.tsx): the drift asks the compositor for a frame every vsync,
// which is most of the app's energy use while it otherwise sits still.
// Only the wallpaper: the spinners and pulses are someone's progress,
// and a frozen one in a window being looked at reads as a hang.
export function usePauseAnimationsOnBattery(): void {
  const { data: config } = useClientConfig();
  const enabled = config?.pauseAnimationsOnBattery ?? true;
  const onBattery = useOnBattery();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("battery-saver", enabled && onBattery);
    return () => root.classList.remove("battery-saver");
  }, [enabled, onBattery]);
}

// The Battery Status API: `charging` means plugged in (also when the
// battery is full), and a machine without a battery reports true, so
// only a real battery ever reads as on battery. A browser without the
// API never does either.
function useOnBattery(): boolean {
  const [onBattery, setOnBattery] = useState(false);
  useEffect(() => {
    // Not in TypeScript's DOM lib, hence the local shape.
    const getBattery = (
      navigator as { getBattery?: () => Promise<BatteryManager> }
    ).getBattery;
    if (getBattery === undefined) return;
    let battery: BatteryManager | undefined;
    let live = true;
    const sync = () => setOnBattery(battery?.charging === false);
    void getBattery
      .call(navigator)
      .then((b) => {
        if (!live) return;
        battery = b;
        sync();
        b.addEventListener("chargingchange", sync);
      })
      // A permissions policy can refuse it: stay running, as on AC.
      .catch(() => undefined);
    return () => {
      live = false;
      battery?.removeEventListener("chargingchange", sync);
    };
  }, []);
  return onBattery;
}

interface BatteryManager extends EventTarget {
  readonly charging: boolean;
}
