import { useSyncExternalStore } from "react";

// A shared wall clock for relative-time labels ("3m ago"), so a window
// left open all day keeps its labels honest instead of freezing them
// at whatever render happened last. One interval serves every
// subscriber, and it only runs while someone is subscribed and the
// document is visible: a hidden window pays nothing and catches up on
// the next visibility change. The tick is coarse on purpose: under a
// minute formatRelativeTime shows seconds, so a label can lag the wall
// clock by up to one tick, and past that it shows minutes.
const TICK_MS = 10_000;

let now = Date.now();
let timer: number | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function start(): void {
  if (timer !== null || document.visibilityState === "hidden") return;
  timer = window.setInterval(tick, TICK_MS);
}

function stop(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    stop();
    return;
  }
  tick();
  start();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // The clock froze when the last subscriber left, so the first one
    // back gets a fresh reading rather than a label built on a `now`
    // from hours ago.
    now = Date.now();
    document.addEventListener("visibilitychange", onVisibilityChange);
    start();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    }
  };
}

function getSnapshot(): number {
  return now;
}

// The current time in milliseconds, re-rendering the caller on a
// coarse shared tick. Pass it as `now` to formatRelativeTime.
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
