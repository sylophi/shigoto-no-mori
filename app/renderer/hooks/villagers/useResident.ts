import type { Worktree } from "@shared/schemas";
import { isBirthdayOn } from "@/lib/villagers/birthdays";
import { useToday } from "@/hooks/ui/useToday";
import { residentOf, type Speaker } from "@/lib/villagerVoice";
import { useVillagerFace, useVillagerProfiles } from "./useVillagers";

// The character whose home a worktree is (residentOf), with their face,
// and whether today (local date) is their birthday.
export type Resident = Omit<Speaker, "color"> & { birthday: boolean };

// A worktree's resident, or null. For the worktree page and the inbox
// row, which show their face every day. `everyDay: false` reads the
// face only on their birthday, for the cake on a sidebar row
// (useVillagerBirthday). Under this window's Village life, like every
// villager extra. Re-renders at midnight, so a window left open all
// night brings the party out, and puts it away, on the right day.
export function useResident(
  worktree: Pick<Worktree, "name" | "isPrimary">,
  { everyDay = true }: { everyDay?: boolean } = {},
): Resident | null {
  const profiles = useVillagerProfiles();
  const today = useToday();
  const speaker =
    profiles === undefined ? null : residentOf(worktree, profiles);
  const birthday =
    speaker !== null && isBirthdayOn(speaker.profile.birthday, today);
  const face = useVillagerFace(
    speaker !== null && (everyDay || birthday) ? speaker.slug : null,
  );
  return speaker === null ? null : { ...speaker, face, birthday };
}

// A worktree's resident on their birthday, or null any other day.
export function useVillagerBirthday(
  worktree: Pick<Worktree, "name" | "isPrimary">,
): Resident | null {
  const resident = useResident(worktree, { everyDay: false });
  return resident?.birthday ? resident : null;
}
