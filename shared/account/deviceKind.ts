// What a device on the account looks like: the one closed catalog of
// device kinds, and the icon every surface draws a device with. A kind
// is the device's own answer (detected at enroll, or picked by its
// owner on the Devices page) and the hub stores it beside the name, so
// every device draws every other one the same way. Shared by the hub
// protocol, both enroll paths (desktop and web), the lab and every
// renderer surface, so the set cannot drift between them. Pure, like
// the rest of shared/account/: no node, no DOM.
//
// Two families. The shapes are what a device can detect itself to be,
// and what it reads as until its owner picks. The marks are picked
// only: a leaf, a cat, a rocket, things that tell two laptops apart at
// a glance, which a shape never can.
import { z } from "zod";
import { WEB_PLATFORM } from "./platform";

export const DEVICE_SHAPES = [
  "laptop",
  "desktop",
  "mini",
  "server",
  "phone",
  "tablet",
  "browser",
] as const;

export const DEVICE_MARKS = [
  "leaf",
  "sprout",
  "flower",
  "clover",
  "pine",
  "mountain",
  "cat",
  "dog",
  "rabbit",
  "squirrel",
  "turtle",
  "snail",
  "fish",
  "bird",
  "bug",
  "star",
  "moon",
  "sun",
  "flame",
  "heart",
  "ghost",
  "rocket",
  "coffee",
  "gamepad",
] as const;

export const DEVICE_KINDS = [...DEVICE_SHAPES, ...DEVICE_MARKS] as const;

export type DeviceShape = (typeof DEVICE_SHAPES)[number];
export type DeviceMark = (typeof DEVICE_MARKS)[number];
export type DeviceKind = DeviceShape | DeviceMark;

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
  leaf: "Leaf",
  sprout: "Sprout",
  flower: "Flower",
  clover: "Clover",
  pine: "Pine",
  mountain: "Mountain",
  cat: "Cat",
  dog: "Dog",
  rabbit: "Rabbit",
  squirrel: "Squirrel",
  turtle: "Turtle",
  snail: "Snail",
  fish: "Fish",
  bird: "Bird",
  bug: "Bug",
  star: "Star",
  moon: "Moon",
  sun: "Sun",
  flame: "Flame",
  heart: "Heart",
  ghost: "Ghost",
  rocket: "Rocket",
  coffee: "Coffee",
  gamepad: "Gamepad",
};

export function isDeviceKind(value: unknown): value is DeviceKind {
  return DeviceKindSchema.safeParse(value).success;
}

// The kind a device of this platform reads as when it never said: a
// device enrolled before kinds existed, or one whose hub row predates
// the column. A browser is a browser; a machine is drawn as a desktop,
// the shape that claims the least.
export function fallbackDeviceKind(platform: string): DeviceShape {
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
