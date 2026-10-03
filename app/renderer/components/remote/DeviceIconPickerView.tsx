// The device icon picker's look (DeviceIconPicker makes the pick): the
// row's mark as the trigger, and a menu of every icon the catalog has
// (shared/account/deviceIcon.ts) as one grid of tiles, the device
// shapes first, then under a hairline the marks that are only ever
// picked.
import { ChevronDown } from "lucide-react";
import {
  DEVICE_ICON_LABELS,
  DEVICE_MARKS,
  DEVICE_SHAPES,
  type DeviceIcon,
} from "@shared/account/deviceIcon";
import { DeviceGlyph, DeviceMark } from "@/components/shared/DeviceGlyph";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

export function DeviceIconPickerView({
  icon,
  tone,
  label,
  detected,
  disabled = false,
  onPick,
}: {
  icon: DeviceIcon;
  tone: StatusTone;
  // "This device" for this one, the peer's name otherwise, for the
  // control's accessible name.
  label: string;
  // What the device detected about itself, the tile that means "back
  // to the default". A peer reports none.
  detected: DeviceIcon | undefined;
  // A pick already on its way.
  disabled?: boolean;
  onPick?: (icon: DeviceIcon) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label} icon: ${DEVICE_ICON_LABELS[icon]}. Change`}
        title="Change icon"
        disabled={disabled}
        className="group relative -m-1 shrink-0 rounded-xl p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 dark:hover:bg-muted/50"
      >
        <DeviceMark icon={icon} tone={tone} size="lg" />
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
// seven, and the marks a multiple of it): the glyph alone, named in
// the tooltip and to assistive tech. The picked tile wears the accent
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
  onPick: ((icon: DeviceIcon) => void) | undefined;
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
            title={name}
            onClick={() => onPick?.(option)}
            className={cn(
              "size-9 justify-center p-0",
              option === picked && "bg-accent text-accent-foreground",
            )}
          >
            <DeviceGlyph icon={option} className="size-4" />
          </DropdownMenuItem>
        );
      })}
    </div>
  );
}
