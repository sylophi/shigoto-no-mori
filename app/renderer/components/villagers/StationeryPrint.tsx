import { cn } from "@/lib/utils";
import { printStyle, type Stationery } from "@/lib/villagers/stationery";

// A legendary character's stationery printed over whatever holds it,
// drifting a tile at a time (lib/villagers/stationery.ts). The holder is
// positioned and clips it. Set its strength with an opacity in
// `className`.
export function StationeryPrint({
  paper,
  className,
}: {
  paper: Stationery;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={printStyle(paper)}
      className={cn(
        "villager-paper-drift absolute right-0 bottom-0",
        paper.color,
        className,
      )}
    />
  );
}
