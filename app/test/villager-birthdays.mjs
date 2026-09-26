// Durable proof for villager birthdays (shared/villagers/birthdays.ts).
// The name pick's invite is the CLI's (cli/birthdays.go, which the
// app's pre-pick asks through `sm worktrees destination`), proven in
// cli/names_test.go.
//
// Asserts:
// - a birthday falls on its local calendar day, and a leap-day one is
//   kept on Feb 28 in common years
// - the day's guests are whoever celebrates that day
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test villager-birthdays.
import assert from "node:assert/strict";
import {
  birthdaySlugsOn,
  calendarDayOf,
  isBirthdayOn,
  monthDayOf,
} from "@shared/villagers/birthdays";
import { makeProof } from "./lib/checkKit.mjs";

const proof = makeProof("villager-birthdays proof");
console.log("villager-birthdays proof\n");

const PROFILES = {
  mitzi: { name: "Mitzi", kind: "villager", birthday: "09-25", url: "" },
  chester: { name: "Chester", kind: "villager", birthday: "09-25", url: "" },
  katrina: { name: "Katrina", kind: "special", birthday: "09-25", url: "" },
  "tom-nook": { name: "Tom Nook", kind: "special", birthday: "09-25", url: "" },
  leap: { name: "Leap", kind: "villager", birthday: "02-29", url: "" },
};
const day = new Date(2026, 8, 25, 12);

try {
  await proof.check("birthdays fall on their local day", () => {
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

  await proof.check("the day's guests are whoever celebrates", () => {
    assert.deepEqual(birthdaySlugsOn(PROFILES, day), [
      "chester",
      "katrina",
      "mitzi",
      "tom-nook",
    ]);
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
