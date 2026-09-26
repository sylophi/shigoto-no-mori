import type { Worktree } from "@shared/schemas";
import { isBirthdayOn } from "@shared/villagers/birthdays";
import { useToday } from "@/hooks/ui/useToday";
import { speakerFor, type Speaker } from "@/lib/villagerVoice";
import { useFaceColor } from "./useFaceColor";
import { useVillagerFace, useVillagerProfiles } from "./useVillagers";

// The character a worktree is named after, on their birthday (local
// date), with their face, or null. Never for the primary checkout: it
// is the project, not a villager's home (worktreeMoves). With `withColor`, a rare one carries
// their color, for their dialogue box, as speakersFor gives it. Under Village life of the
// device the surrounding HostScope names, like every villager extra.
// Re-renders at midnight, so a window left open all night brings the
// cake out, and puts it away, on the right day.
export function useVillagerBirthday(
  worktree: Pick<Worktree, "name" | "isPrimary">,
  { withColor = false }: { withColor?: boolean } = {},
): Speaker | null {
  const profiles = useVillagerProfiles();
  const today = useToday();
  const speaker =
    profiles === undefined || worktree.isPrimary
      ? null
      : speakerFor(worktree.name, profiles);
  const celebrating =
    speaker !== null && isBirthdayOn(speaker.profile.birthday, today)
      ? speaker
      : null;
  const face = useVillagerFace(celebrating?.slug ?? null);
  const color = useFaceColor(
    withColor && celebrating?.rarity === "rare" ? face : null,
  );
  return celebrating === null ? null : { ...celebrating, face, color };
}
