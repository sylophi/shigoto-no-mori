import { useSyncExternalStore } from "react";
import { calendarDayOf } from "../lib/villagers/birthdays.ts";
import { subscribeClock } from "./useNow.ts";

// The local calendar day, for what changes with it (a villager's
// birthday). It rides the shared clock's tick and wake, but the snapshot
// is one Date per day, so subscribers re-render once, when the day rolls
// over (up to a tick late), not on every tick.

let posed = false;
let today = new Date();

// The fake host's `?today=` pose (lab/fake-host/boot.tsx), set before
// the app mounts, so a birthday can be posed without touching the
// clock.
export function poseToday(date: Date): void {
  posed = true;
  today = date;
}

function getSnapshot(): Date {
  if (!posed) {
    const now = new Date();
    if (calendarDayOf(now) !== calendarDayOf(today)) today = now;
  }
  return today;
}

// Today's date, re-rendering the caller when it changes.
export function useToday(): Date {
  return useSyncExternalStore(subscribeClock, getSnapshot, getSnapshot);
}
