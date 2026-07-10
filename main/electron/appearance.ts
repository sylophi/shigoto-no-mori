// Live doubutsu state for native window chrome. Seeded synchronously
// from config.json at first access (window-create time), then kept
// current by the renderer through the runtime:setDoubutsu IPC --
// including unsaved Settings previews, mirroring how setTheme drives
// nativeTheme. Only win32 chrome consumes this today; macOS vibrancy
// needs no doubutsu-specific native paint.
import { readDoubutsuSync } from "../lib/config/global";

let doubutsu: boolean | null = null;
const listeners = new Set<() => void>();

export function isDoubutsu(): boolean {
  doubutsu ??= readDoubutsuSync();
  return doubutsu;
}

export function setDoubutsu(enabled: boolean): void {
  if (doubutsu === enabled) return;
  doubutsu = enabled;
  for (const listener of listeners) listener();
}

export function onAppearanceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
