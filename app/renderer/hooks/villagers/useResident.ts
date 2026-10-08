import type { Worktree } from "@shigomori/contracts/schemas";
import { isBirthdayOn } from "@/lib/villagers/birthdays";
import { useToday } from "@/hooks/ui/useToday";
import { residentOf, type Speaker } from "@/lib/villagerVoice";
import { useVillagerFace, useVillagerProfiles } from "./useVillagers";

// The character whose home a worktree is (residentOf), with their face,
// and whether today (local date) is their birthday.
export type Resident = Omit<Speaker, "color"> & { birthday: boolean };

// A worktree's resident, or null. For the worktree page and the
// sidebar's rows, which show their face every day. Under this window's
// Village life, like every villager extra. Re-renders at midnight, so a
// window left open all night brings the party out, and puts it away, on
// the right day.
export function useResident(
  worktree: Pick<Worktree, "name" | "isPrimary">,
): Resident | null {
  const profiles = useVillagerProfiles();
  const today = useToday();
  const speaker =
    profiles === undefined ? null : residentOf(worktree, profiles);
  const birthday =
    speaker !== null && isBirthdayOn(speaker.profile.birthday, today);
  const face = useVillagerFace(speaker?.slug ?? null);
  return speaker === null ? null : { ...speaker, face, birthday };
}
