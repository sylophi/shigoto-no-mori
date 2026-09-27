import { Cake } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useVillagerBirthday } from "@/hooks/villagers/useResident";
import { BirthdayFace } from "./BirthdayFace";

// The cake a worktree row wears on its villager's birthday, with their
// party-hatted face in the tooltip. Nothing on any other day, or for any
// other name, whichever device the worktree lives on.
export function BirthdayBadge({
  worktree,
}: {
  worktree: Pick<Worktree, "name" | "isPrimary">;
}) {
  const villager = useVillagerBirthday(worktree);
  if (villager === null) return null;
  const tip = `${villager.profile.name}'s birthday today`;
  return (
    <SimpleTooltip
      tip={
        <span className="flex items-center gap-2">
          {villager.face && (
            <BirthdayFace face={villager.face} className="mt-1 size-6" />
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
