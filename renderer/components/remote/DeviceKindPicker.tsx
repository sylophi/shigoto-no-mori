// This device's icon, picked in place: the mark on its Devices page
// row is the trigger, and the menu lists every kind the catalog has
// (shared/account/deviceKind.ts), each with its glyph, with what the
// device detected about itself marked as such. Picking the detected
// one drops the pick (the store's rule: no pick means "what I
// detected"), so a device put back to its default carries no override
// that a later, better detection could not move. The pick rides the
// same path a rename does, so every other device sees the new mark on
// its next registry read.
import { ChevronDown } from "lucide-react";
import {
  DEVICE_KINDS,
  DEVICE_KIND_LABELS,
  type DeviceKind,
} from "@shared/account/deviceKind";
import { DeviceIcon, DeviceMark } from "@/components/shared/DeviceIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StatusTone } from "@/components/ui/status-dot";
import { useSetDeviceKind } from "@/hooks/account/useAccount";

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
        {/* The label is a group part, so it sits inside the group. */}
        <DropdownMenuRadioGroup
          value={kind}
          onValueChange={(next) => {
            const picked = next as DeviceKind;
            setDeviceKind.mutate(picked === detectedKind ? null : picked);
          }}
        >
          <DropdownMenuLabel>Icon</DropdownMenuLabel>
          {DEVICE_KINDS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <DeviceIcon kind={option} className="size-3.5" />
              {DEVICE_KIND_LABELS[option]}
              {option === detectedKind && (
                <span className="ml-auto pl-3 text-2xs text-muted-foreground">
                  detected
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
