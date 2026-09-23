// The one way a device is drawn: its kind as a glyph (DeviceIcon), and
// that glyph on a tinted tile in the device's connection tone
// (DeviceMark). Every surface that stands for a machine (the sidebar's
// badges, the filter pills, the device tabs and chips, the settings
// list, the Devices page, the pull flow's two ends) draws through
// these two, so a machine looks the same everywhere and a picked icon
// lands everywhere at once. The kind comes from the device's own
// answer (shared/account/deviceKind.ts), never from guessing at the
// name or the platform here.
import {
  Apple,
  Bird,
  Bug,
  Cat,
  Cherry,
  Cloud,
  Clover,
  Coffee,
  Dog,
  Fish,
  Flame,
  Flower,
  Gamepad2,
  Ghost,
  Globe,
  Heart,
  Laptop,
  Leaf,
  Monitor,
  Moon,
  Mountain,
  Rabbit,
  Rocket,
  Server,
  Smartphone,
  Snail,
  Sprout,
  Squirrel,
  Star,
  Sun,
  Tablet,
  TreePine,
  Turtle,
  Zap,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";
import type { DeviceKind } from "@shared/account/deviceKind";
import { TONE_PILL, type StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

// A small box (a Mac mini, a NUC): lucide has no such glyph, so this is
// one drawn in its style, a low slab with a status light and a
// tabletop line so it reads beside the others at 14px.
function Mini({ className, ...props }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("lucide", className)}
      {...props}
    >
      <rect x="3" y="8" width="18" height="8" rx="2" />
      <path d="M7 12h.01" />
      <path d="M6 20h12" />
    </svg>
  );
}

const GLYPH: Record<DeviceKind, ComponentType<LucideProps>> = {
  laptop: Laptop,
  desktop: Monitor,
  mini: Mini,
  server: Server,
  phone: Smartphone,
  tablet: Tablet,
  browser: Globe,
  leaf: Leaf,
  sprout: Sprout,
  flower: Flower,
  clover: Clover,
  pine: TreePine,
  mountain: Mountain,
  cloud: Cloud,
  zap: Zap,
  apple: Apple,
  cherry: Cherry,
  cat: Cat,
  dog: Dog,
  rabbit: Rabbit,
  squirrel: Squirrel,
  turtle: Turtle,
  snail: Snail,
  fish: Fish,
  bird: Bird,
  bug: Bug,
  star: Star,
  moon: Moon,
  sun: Sun,
  flame: Flame,
  heart: Heart,
  ghost: Ghost,
  rocket: Rocket,
  coffee: Coffee,
  gamepad: Gamepad2,
};

// The bare glyph, sized by the caller like any lucide icon. Decorative
// by default: the name beside it carries the meaning, and a mark that
// stands alone labels itself.
export function DeviceIcon({
  kind,
  className,
  ...props
}: { kind: DeviceKind } & LucideProps) {
  const Glyph = GLYPH[kind];
  return <Glyph aria-hidden className={cn("shrink-0", className)} {...props} />;
}

// The glyph on a tile washed in the device's connection tone, drawn
// through the shared TONE_PILL table so a mark and a dot can never
// disagree about a machine. Two sizes: the row badge the sidebar wears
// and the avatar that anchors a row on the Devices page.
export function DeviceMark({
  kind,
  tone,
  size = "sm",
  className,
}: {
  kind: DeviceKind;
  tone: StatusTone;
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center select-none",
        size === "sm" ? "size-4 rounded" : "size-9 rounded-lg",
        TONE_PILL[tone],
        className,
      )}
    >
      <DeviceIcon kind={kind} className={size === "sm" ? "size-3" : "size-5"} />
    </span>
  );
}
