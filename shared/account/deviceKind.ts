// What a device on the account looks like: the one closed catalog of
// device kinds, and the icon every surface draws a device with. A kind
// is the device's own answer (detected at enroll, or picked by its
// owner on the Devices page) and the hub stores it beside the name, so
// every device draws every other one the same way. Shared by the hub
// protocol, both enroll paths (desktop and web), the lab and every
// renderer surface, so the set cannot drift between them. Pure, like
// the rest of shared/account/: no node, no DOM.
import { z } from "zod";
import { WEB_PLATFORM } from "./platform";

export const DEVICE_KINDS = [
  "laptop",
  "desktop",
  "mini",
  "server",
  "phone",
  "tablet",
  "browser",
] as const;

export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DeviceKindSchema = z.enum(DEVICE_KINDS);

// The kind as the picker names it.
export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  laptop: "Laptop",
  desktop: "Desktop",
  mini: "Mini",
  server: "Server",
  phone: "Phone",
  tablet: "Tablet",
  browser: "Browser",
};

export function isDeviceKind(value: unknown): value is DeviceKind {
  return DeviceKindSchema.safeParse(value).success;
}

// The kind a device of this platform reads as when it never said: a
// device enrolled before kinds existed, or one whose hub row predates
// the column. A browser is a browser; a machine is drawn as a desktop,
// the shape that claims the least.
export function fallbackDeviceKind(platform: string): DeviceKind {
  return platform === WEB_PLATFORM ? "browser" : "desktop";
}

// The kind a registry row draws as: what the row says, when it says
// something this build knows, else the platform fallback. A kind from
// a newer build passes through the wire as a string, so an unknown one
// falls back rather than crashing an older client.
export function resolveDeviceKind(
  kind: string | null | undefined,
  platform: string,
): DeviceKind {
  return isDeviceKind(kind) ? kind : fallbackDeviceKind(platform);
}
