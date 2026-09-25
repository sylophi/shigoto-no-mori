// A device's icon, picked in place: the mark on its Devices page row
// is the trigger, and the menu lays out every icon the catalog has
// (shared/account/deviceIcon.ts) as one grid of tiles: the device
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
import { useAccountStatus, useSetDeviceIcon } from "@/hooks/account/useAccount";
import { cn } from "@/lib/utils";

export function DeviceIconPicker({
  deviceId,
  isThisDevice,
  icon,
  tone,
  // "This device" for this one, the peer's name otherwise, for the
  // control's accessible name.
  label,
}: {
  deviceId: string;
  isThisDevice: boolean;
  icon: DeviceIcon;
  tone: StatusTone;
  label: string;
}) {
  const setDeviceIcon = useSetDeviceIcon();
  const status = useAccountStatus().data;
  // What this device detected about itself, for the tile that means
  // "back to the default": the icon worn now until the status lands,
  // moments before the picker re-renders with the real answer. A peer
  // reports no detection to the hub, so its tiles name none.
  const detected = isThisDevice
    ? (status?.detectedDeviceIcon ?? icon)
    : undefined;
  const onPick = (next: DeviceIcon) => {
    if (next !== icon) setDeviceIcon.mutate({ deviceId, icon: next });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label} icon: ${DEVICE_ICON_LABELS[icon]}. Change`}
        title="Change icon"
        disabled={setDeviceIcon.isPending}
        className="group relative shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
      >
        <DeviceMark icon={icon} tone={tone} size="lg" />
        {/* A small cue that the mark opens something, kept off the
            marks that open nothing. */}
        <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground group-hover:text-foreground">
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
            title={name}
            onClick={() => onPick(option)}
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
