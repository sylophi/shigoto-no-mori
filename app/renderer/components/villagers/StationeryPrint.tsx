import { cn } from "@/lib/utils";
import { printStyle, type Stationery } from "@/lib/villagers/stationery";

// A legendary character's stationery printed over whatever holds it,
// drifting a tile at a time (lib/villagers/stationery.ts), or `still`
// on paper that stays put, like the guest book's page. The holder is
// positioned and clips it. Set its strength with an opacity in
// `className`.
export function StationeryPrint({
  paper,
  still = false,
  className,
}: {
  paper: Stationery;
  still?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={printStyle(paper)}
      className={cn(
        "absolute right-0 bottom-0",
        !still && "villager-paper-drift",
        paper.color,
        className,
      )}
    />
  );
}
