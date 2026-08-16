import { cn } from "@/lib/utils";
import type { TrayStatus } from "./trayStatus";

// Only the four raw color families doubutsu remaps (emerald / rose /
// amber / sky) plus the neutral token -- see the CONTRACT header in
// renderer/doubutsu.css. A fifth family here would go untranslated in
// doubutsu mode.
const DOT_CLASSES: Record<TrayStatus, string> = {
  attention: "bg-rose-500",
  dirty: "bg-amber-500",
  behind: "bg-sky-500",
  ahead: "bg-emerald-500",
  // Calm states fade rather than disappear, so the column of dots still
  // lines up. A ring or border would have been the nicer shape, but
  // doubutsu strips both globally (see "Strip ambient depth" in
  // doubutsu.css) -- a translucent fill survives the overlay.
  clean: "bg-muted-foreground/35",
};

export function StatusDot({ status }: { status: TrayStatus }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", DOT_CLASSES[status])}
    />
  );
}
