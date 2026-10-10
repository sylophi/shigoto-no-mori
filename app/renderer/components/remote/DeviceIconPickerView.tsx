// A device's icon, picked in place: the mark on its account page row
// is the trigger, and the menu lays out every icon the catalog has
// (packages/contracts/src/deviceIcon.ts) as one grid of tiles: the device
// shapes as the first row, with what the device detected about itself
// named as such, then under a hairline the marks that are only ever
// picked (a leaf, a cat, a rocket), which tell two laptops apart the
// way a shape never can. No headings: the tiles say what they are.
// Picking the detected shape drops the pick (the store's rule: no pick
// means "what I detected"), so a device put back to its default carries
// no override that a later, better detection could not move. The pick
// is made on the device hub, so any row offers it, a peer's included,
// online or not: every device sees the new mark on its next registry
// read, the picked one too (shared/account/enroll.ts).
import { ChevronDown } from "lucide-react";
import {
  DEVICE_ICON_LABELS,
  DEVICE_MARKS,
  DEVICE_SHAPES,
  type DeviceIcon,
} from "@shigomori/contracts/deviceIcon";
import {
  DeviceGlyphView,
  DeviceMarkView,
} from "@/components/shared/DeviceGlyphView";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import type { StatusTone } from "@shigomori/ui/primitives/status-dot.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

export function DeviceIconPickerView({
  icon,
  tone,
  // "This device" for this one, the peer's name otherwise, for the
  // control's accessible name.
  label,
  detected,
  disabled,
  onPick,
}: {
  icon: DeviceIcon;
  tone: StatusTone;
  label: string;
  // What the device detected about itself, for the tile that means
  // "back to the default". Undefined for a peer, which reports none.
  detected: DeviceIcon | undefined;
  disabled: boolean;
  onPick: (icon: DeviceIcon) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label} icon: ${DEVICE_ICON_LABELS[icon]}. Change`}
        disabled={disabled}
        className="group relative -m-1 shrink-0 rounded-xl p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 dark:hover:bg-muted/50"
      >
        <DeviceMarkView icon={icon} tone={tone} size="lg" />
        {/* A small cue that the mark opens something, kept off the
              marks that open nothing. */}
        <span className="absolute right-0 bottom-0 flex size-3.5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground group-hover:text-foreground">
          <ChevronDown aria-hidden className="size-2.5" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <IconTiles
          icons={DEVICE_SHAPES}
          picked={icon}
          detected={detected}
          onPick={onPick}
        />
        <DropdownMenuSeparator />
        <IconTiles
          icons={DEVICE_MARKS}
          picked={icon}
          detected={detected}
          onPick={onPick}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One family as a grid of square tiles, seven across (the shapes are
// seven, and the marks a multiple of it): the glyph alone, named to
// assistive tech. The picked tile wears the accent
// fill every selection in the app wears, and the detected one says so
// in its name, since it is the entry that means "back to the default".
function IconTiles({
  icons,
  picked,
  detected,
  onPick,
}: {
  icons: readonly DeviceIcon[];
  picked: DeviceIcon;
  detected: DeviceIcon | undefined;
  onPick: (icon: DeviceIcon) => void;
}) {
  return (
    <div className="grid grid-cols-7 gap-0.5 p-1">
      {icons.map((option) => {
        // The tile's whole name: the icon, and whether it is the
        // one worn now or the one the device detected.
        const name = [
          DEVICE_ICON_LABELS[option],
          option === picked ? "(current)" : null,
          option === detected ? "(detected)" : null,
        ]
          .filter((part) => part !== null)
          .join(" ");
        return (
          <DropdownMenuItem
            key={option}
            aria-label={name}
            onClick={() => onPick(option)}
            className={cn(
              "size-9 justify-center p-0",
              option === picked && "bg-accent text-accent-foreground",
            )}
          >
            <DeviceGlyphView icon={option} className="size-4" />
          </DropdownMenuItem>
        );
      })}
    </div>
  );
}
