import { cn } from "@/lib/utils";

// A cardboard moving box, flaps open and taped down the middle: what a
// villager moving out is packed into. Drawn flat, in the amber the theme
// remaps. Size it with `className` (a width: it keeps its own aspect).
export function MovingBox({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 40 30"
      data-slot="villager-moving-box"
      className={cn("pointer-events-none", className)}
    >
      <path className="fill-amber-700" d="M3 11L0 3.5L16 5L19 11Z" />
      <path className="fill-amber-700" d="M37 11L40 3.5L24 5L21 11Z" />
      <rect
        className="fill-amber-500"
        x="2"
        y="10"
        width="36"
        height="20"
        rx="2"
      />
      <rect className="fill-amber-300" x="17" y="10" width="6" height="20" />
      <rect className="fill-amber-600" x="2" y="10" width="36" height="2.2" />
    </svg>
  );
}
