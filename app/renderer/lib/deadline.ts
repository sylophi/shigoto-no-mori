// A deadline in this page's memory, read on both clocks: it has passed
// once either says so, so neither a sleep (the monotonic clock stands
// still while the wall one runs on) nor a clock step (the wall one
// jumps, backwards included) stretches it. A timer that only redraws
// can fire late; whatever the deadline decides is checked here.
export interface Deadline {
  readonly monotonic: number;
  readonly wall: number;
  readonly ms: number;
}

interface Clocks {
  readonly monotonic: number;
  readonly wall: number;
}

const clocks = (): Clocks => ({
  monotonic: performance.now(),
  wall: Date.now(),
});

export function deadlineIn(ms: number, now: Clocks = clocks()): Deadline {
  return { ...now, ms };
}

export function deadlinePassed(
  deadline: Deadline,
  now: Clocks = clocks(),
): boolean {
  const wall = now.wall - deadline.wall;
  return (
    now.monotonic - deadline.monotonic >= deadline.ms ||
    wall < 0 ||
    wall >= deadline.ms
  );
}
