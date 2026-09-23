// A device's icon, picked in place: the mark on its Devices page row
// is the trigger, and the menu lays out every kind the catalog has
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
//
// This device's row picks for itself. A peer's row picks for the peer
// when the peer allows control from here: the pick is still the peer's
// own, made through its host api (shared/ipc/modules/device.ts).
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
import { useAccountStatus, useSetDeviceKind } from "@/hooks/account/useAccount";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { useSetPeerDeviceKind } from "@/hooks/remote/usePeerDeviceKind";
import { cn } from "@/lib/utils";

export function DeviceKindPicker({
  kind,
  tone,
  // "This device" / "This browser", for the control's accessible name.
  label,
}: {
  kind: DeviceKind;
  tone: StatusTone;
  label: string;
}) {
  const setDeviceKind = useSetDeviceKind();
  // What this device detected about itself, for the tile that means
  // "back to the default". The kind worn now until the status lands,
  // moments before the picker re-renders with the real answer.
  const detectedKind = useAccountStatus().data?.detectedDeviceKind ?? kind;
  return (
    <KindPickerMenu
      kind={kind}
      tone={tone}
      label={label}
      detected={detectedKind}
      pending={setDeviceKind.isPending}
      onPick={(next) => setDeviceKind.mutate(next)}
    />
  );
}

export function PeerDeviceKindPicker({
  deviceId,
  api,
  kind,
  detected,
  tone,
  // The peer's name, for the control's accessible name and the error.
  name,
}: {
  deviceId: string;
  api: HostApi;
  kind: DeviceKind;
  // What the peer detected about itself (usePeerDetectedKind), read by
  // the row, which offers this picker only once the peer answered.
  detected: DeviceKind;
  tone: StatusTone;
  name: string;
}) {
  const setPeerKind = useSetPeerDeviceKind(deviceId, api, name);
  return (
    <KindPickerMenu
      kind={kind}
      tone={tone}
      label={name}
      detected={detected}
      pending={setPeerKind.isPending}
      onPick={(next) => setPeerKind.mutate(next)}
    />
  );
}

function KindPickerMenu({
  kind,
  tone,
  label,
  detected,
  pending,
  onPick,
}: {
  kind: DeviceKind;
  tone: StatusTone;
  label: string;
  detected: DeviceKind | undefined;
  pending: boolean;
  onPick: (kind: DeviceKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${label} icon: ${DEVICE_KIND_LABELS[kind]}. Change`}
        title="Change icon"
        disabled={pending}
        className="group relative shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
      >
        <DeviceMark kind={kind} tone={tone} size="lg" />
        {/* A small cue that the mark opens something, kept off the
            marks that open nothing. */}
        <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground group-hover:text-foreground">
          <ChevronDown aria-hidden className="size-2.5" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <KindTiles
          kinds={DEVICE_SHAPES}
          picked={kind}
          detected={detected}
          onPick={onPick}
        />
        <DropdownMenuSeparator />
        <KindTiles
          kinds={DEVICE_MARKS}
          picked={kind}
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
function KindTiles({
  kinds,
  picked,
  detected,
  onPick,
}: {
  kinds: readonly DeviceKind[];
  picked: DeviceKind;
  detected: DeviceKind | undefined;
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
