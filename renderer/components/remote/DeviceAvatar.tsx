// The device's two-letter mark, the same one its sidebar badges wear
// (deviceAbbrev), sized up to anchor its row on the Devices page. The
// tone is the connection tone drawn through the shared TONE_PILL table,
// so the mark here and the badge in the tree can never disagree about
// a machine -- and a glance at the page teaches what "TH" means in the
// sidebar.
import { TONE_PILL, type StatusTone } from "@/components/ui/status-dot";
import { deviceAbbrev } from "@/lib/deviceAbbrev";
import { cn } from "@/lib/utils";

export function DeviceAvatar({
  name,
  tone,
}: {
  name: string;
  tone: StatusTone;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold tracking-wider select-none",
        TONE_PILL[tone],
      )}
    >
      {deviceAbbrev(name)}
    </span>
  );
}
