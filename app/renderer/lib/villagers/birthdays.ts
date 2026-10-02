// Villager birthdays, on the local calendar. A worktree named after a
// villager celebrates their birthday (Village life), read off the
// profiles the villager data download holds. The date is always passed
// in, so every rule here holds on any day of the year.

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

const BIRTHDAY = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
});

// A "MM-DD" birthday as people say it ("September 25"), or null without
// one.
export function birthdayLabel(birthday: string | undefined): string | null {
  const [month, day] = birthday?.split("-").map(Number) ?? [];
  if (month === undefined || day === undefined) return null;
  return BIRTHDAY.format(new Date(2000, month - 1, day));
}
