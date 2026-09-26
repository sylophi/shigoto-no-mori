import { useSyncExternalStore } from "react";
import { calendarDayOf } from "@shared/villagers/birthdays";

// The local calendar day, for what changes with it (a villager's
// birthday). Subscribers re-render once, when the day rolls over, not on
// a tick: one timer aims at the next local midnight, and a window coming
// back into view or focus re-reads the date in case the machine slept
// through it (a timer doesn't count asleep time).
// The snapshot is one Date per day, so reading it costs nothing between
// rollovers.

let posed: Date | null = null;
let today = new Date();
let timer: number | null = null;
const listeners = new Set<() => void>();

// The UI lab's `?today=` pose (lab/boot.tsx), set before the app mounts,
// so a birthday can be posed without touching the clock.
export function poseToday(date: Date): void {
  posed = date;
  today = date;
}

function refresh(): void {
  if (posed) return;
  const now = new Date();
  if (calendarDayOf(now) === calendarDayOf(today)) return;
  today = now;
  for (const listener of listeners) listener();
}

function schedule(): void {
  if (posed) return;
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  // A second past midnight, so the timer can't land a hair early and
  // read the old day.
  timer = window.setTimeout(
    () => {
      refresh();
      schedule();
    },
    midnight.getTime() - now.getTime() + 1000,
  );
}

function onWake(): void {
  if (document.visibilityState !== "visible") return;
  refresh();
  if (timer !== null) window.clearTimeout(timer);
  schedule();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    refresh();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    schedule();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    }
  };
}

function getSnapshot(): Date {
  return today;
}

// Today's date, re-rendering the caller when it changes.
export function useToday(): Date {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
