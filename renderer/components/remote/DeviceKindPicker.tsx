// This device's icon, picked in place: the mark on its Devices page
// row is the trigger, and the menu lays out every kind the catalog has
// (shared/account/deviceKind.ts) as one grid of tiles: the device
// shapes as the first row, with what the device detected about itself
// named as such, then under a hairline the marks that are only ever
// picked (a leaf, a cat, a rocket), which tell two laptops apart the
// way a shape never can. No headings: the tiles say what they are.
// Picking the detected shape drops the pick (the store's rule: no pick
// means "what I detected"), so a device put back to its default carries
// no override that a later, better detection could not move. The pick
// rides the same path a rename does, so every other device sees the new
// mark on its next registry read.
import { ChevronDown } from "lucide-react";
import {
  DEVICE_KIND_LABELS,
  DEVICE_MARKS,
  DEVICE_SHAPES,
  type DeviceKind,
} from "@shared/account/deviceKind";
import { DeviceIcon, DeviceMark } from "@/components/shared/DeviceIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StatusTone } from "@/components/ui/status-dot";
import { useSetDeviceKind } from "@/hooks/account/useAccount";
import { cn } from "@/lib/utils";

export function DeviceKindPicker({
  kind,
  detectedKind,
  tone,
  // "This device" / "This browser", for the control's accessible name.
  label,
}: {
  kind: DeviceKind;
  detectedKind: DeviceKind;
  tone: StatusTone;
  label: string;
}) {
  const setDeviceKind = useSetDeviceKind();
  const pick = (next: DeviceKind) =>
    setDeviceKind.mutate(next === detectedKind ? null : next);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label} icon: ${DEVICE_KIND_LABELS[kind]}. Change`}
        title="Change icon"
        disabled={setDeviceKind.isPending}
        className="group relative shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
      >
        <DeviceMark kind={kind} tone={tone} size="lg" />
        {/* A small cue that the mark opens something, kept off the
            peers' marks, which open nothing. */}
        <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground group-hover:text-foreground">
          <ChevronDown aria-hidden className="size-2.5" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <KindTiles
          kinds={DEVICE_SHAPES}
          picked={kind}
          detected={detectedKind}
          onPick={pick}
        />
        <DropdownMenuSeparator />
        <KindTiles
          kinds={DEVICE_MARKS}
          picked={kind}
          detected={detectedKind}
          onPick={pick}
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
function KindTiles({
  kinds,
  picked,
  detected,
  onPick,
}: {
  kinds: readonly DeviceKind[];
  picked: DeviceKind;
  detected: DeviceKind;
  onPick: (kind: DeviceKind) => void;
}) {
  return (
    <div className="grid grid-cols-7 gap-0.5 p-1">
      {kinds.map((option) => {
        // The tile's whole name: the kind, and whether it is the
        // one worn now or the one the device detected.
        const name = [
          DEVICE_KIND_LABELS[option],
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
            <DeviceIcon kind={option} className="size-4" />
          </DropdownMenuItem>
        );
      })}
    </div>
  );
}
