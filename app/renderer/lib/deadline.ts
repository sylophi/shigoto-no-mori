// A deadline in this page's memory, read on both clocks: it has passed
// once either says so, so neither a sleep (the monotonic clock stands
// still while the wall one runs on) nor a clock step (the wall one
// jumps, backwards included) stretches it. A timer that only redraws
// can fire late, but whatever the deadline decides is checked here.
export interface Deadline {
  readonly monotonic: number;
  readonly wall: number;
  readonly ms: number;
}

const clocks = () => ({
  monotonic: performance.now(),
  wall: Date.now(),
});

export function deadlineIn(ms: number): Deadline {
  return { ...clocks(), ms };
}

export function deadlinePassed(deadline: Deadline): boolean {
  const now = clocks();
  const wall = now.wall - deadline.wall;
  return (
    now.monotonic - deadline.monotonic >= deadline.ms ||
    wall < 0 ||
    wall >= deadline.ms
  );
}
