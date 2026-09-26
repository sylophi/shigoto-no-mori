import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { VillagerLine } from "@/lib/villagerVoice";

// How a villager shows on a product surface (DESIGN.md, "Village life:
// rarity"). The face is the same for every character. A rarity shows
// in how their news arrives instead (components/villagers).

// A line in a villager's voice (lib/villagerVoice.ts): the message as
// written, then the catchphrase, set a step quieter so the news still
// reads first. Inline, so it sits in a toast title or a sentence.
export function VillagerSays({ line }: { line: VillagerLine }) {
  return (
    <>
      {line.lead}
      <span
        data-slot="villager-voice"
        title={`${line.speaker}'s catchphrase`}
        className="text-muted-foreground"
      >
        {line.tail}
      </span>
    </>
  );
}

// The speaker's face (a data URL) on a soft round tint, so a near-white
// villager (Bianca, Rolf) keeps an edge on a white or dark surface.
// `badge` sits on the bottom corner, which the faces leave empty. Size
// it with `className` (a size-* utility).
export function VillagerFace({
  face,
  badge,
  className,
}: {
  face: string;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-slot="villager-face"
      className={cn(
        "relative inline-flex shrink-0 rounded-full bg-emerald-500/15",
        className,
      )}
    >
      <img
        src={face}
        alt=""
        draggable={false}
        decoding="async"
        className="size-full rounded-full object-contain select-none"
      />
      {badge}
    </span>
  );
}
