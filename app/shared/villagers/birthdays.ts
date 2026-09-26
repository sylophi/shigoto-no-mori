import type { VillagerProfiles } from "@shared/schemas";

// Villager birthdays, on the local calendar. A worktree named after a
// villager celebrates their birthday (Village life), and the name pick
// invites whoever's birthday it is. The date is always passed in, so
// every rule here holds on any day of the year. cli/birthdays.go keeps
// the same rules for the CLI's pick.

const pad = (n: number) => String(n).padStart(2, "0");

// The local calendar day as the profiles spell birthdays, "MM-DD".
export function monthDayOf(date: Date): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A key that changes exactly at local midnight.
export function calendarDayOf(date: Date): string {
  return `${date.getFullYear()}-${monthDayOf(date)}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Whether a "MM-DD" birthday falls on `date`. A leap-day birthday is
// kept on Feb 28 in the three years without a Feb 29.
export function isBirthdayOn(
  birthday: string | undefined,
  date: Date,
): boolean {
  if (birthday === undefined) return false;
  const today = monthDayOf(date);
  if (birthday === today) return true;
  return (
    birthday === "02-29" && today === "02-28" && !isLeapYear(date.getFullYear())
  );
}

// Every character celebrating on `date`, for the name pick to invite.
export function birthdaySlugsOn(
  profiles: VillagerProfiles,
  date: Date,
): string[] {
  return Object.entries(profiles)
    .filter(([, profile]) => isBirthdayOn(profile.birthday, date))
    .map(([slug]) => slug)
    .toSorted();
}
