import { Cake } from "lucide-react";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import type { Resident } from "@/hooks/villagers/useResident";
import { BirthdayFaceView } from "./BirthdayFaceView";

// The cake a worktree row wears on its villager's birthday, with their
// party-hatted face in the tooltip. Nothing on any other day, or for any
// other name, whichever device the worktree lives on. The row already
// holds its resident (useResident), so it hands it over rather than
// have the badge look them up again.
export function BirthdayBadgeView({ resident }: { resident: Resident | null }) {
  if (!resident?.birthday) return null;
  const tip = `${resident.profile.name}'s birthday today`;
  return (
    <SimpleTooltip
      tip={
        <span className="flex items-center gap-2">
          {resident.face && (
            <BirthdayFaceView face={resident.face} className="mt-1 size-6" />
          )}
          {tip}
        </span>
      }
    >
      <Cake
        role="img"
        aria-label={tip}
        className="size-3 shrink-0 text-amber-500"
      />
    </SimpleTooltip>
  );
}
