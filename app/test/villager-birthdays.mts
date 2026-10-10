// Durable proof for villager birthdays (ui's lib/villagers/birthdays.ts).
//
// Asserts:
// - a birthday falls on its local calendar day, and a leap-day one is
//   kept on Feb 28 in common years
//
// Run: pnpm test villager-birthdays.
import assert from "node:assert/strict";
import {
  calendarDayOf,
  isBirthdayOn,
  monthDayOf,
} from "@shigomori/ui/lib/villagers/birthdays.ts";
import { it } from "vitest";

const day = new Date(2026, 8, 25, 12);

it("birthdays fall on their local day", () => {
  assert.equal(monthDayOf(day), "09-25");
  assert.equal(calendarDayOf(day), "2026-09-25");
  assert.ok(isBirthdayOn("09-25", day));
  assert.ok(!isBirthdayOn("09-26", day));
  assert.ok(!isBirthdayOn(undefined, day));
  // Feb 29 keeps to Feb 28 in a common year, and only then.
  assert.ok(isBirthdayOn("02-29", new Date(2027, 1, 28, 12)));
  assert.ok(!isBirthdayOn("02-29", new Date(2028, 1, 28, 12)));
  assert.ok(isBirthdayOn("02-29", new Date(2028, 1, 29, 12)));
});
