import { VillagerFace } from "@/components/shared/VillagerSays";
import { cn } from "@/lib/utils";

// A paper party hat, tipped on its side: a striped cone with a pom on
// top, drawn flat in the palette doubutsu remaps.
function PartyHat({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 18"
      className={cn("pointer-events-none", className)}
    >
      <path className="fill-rose-500" d="M7 3L13 17H1Z" />
      <path className="fill-amber-300" d="M4.9 8H9.1L10.3 10.8H3.7Z" />
      <path className="fill-amber-300" d="M3 12.6H11L12.2 15.4H1.8Z" />
      <circle className="fill-amber-400" cx="7" cy="2.6" r="2.2" />
    </svg>
  );
}

// A villager's face on their birthday: the usual face, in a party hat.
// Size it with `className` (a size-* utility): the hat follows.
export function BirthdayFace({
  face,
  className,
}: {
  face: string;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <VillagerFace face={face} className="size-full" />
      <PartyHat className="absolute -top-[38%] right-[-8%] h-[62%] rotate-[20deg]" />
    </span>
  );
}
