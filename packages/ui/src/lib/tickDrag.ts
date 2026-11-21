import type { PointerEvent as ReactPointerEvent } from "react";
import { plainMousePress } from "./pointerIntent.ts";

const ROW = "[data-tick-drag]";
const BOX = '[data-slot="checkbox"]';

// Press on a checkbox row and drag over the rows beside it to set them
// all the way the pressed one goes. A list puts this on its
// onPointerDown, and each row marks the element a click toggles with
// data-tick-drag. Rows are set by clicking them, so each keeps its own
// handler. A row is found in the pressed one's column at the pointer's
// height, so the drag can wander off to the side, and the rows between
// two moves are set too, for a drag fast enough to skip some. Touch is
// left to scroll.
export function startTickDrag(event: ReactPointerEvent<HTMLElement>) {
  if (!plainMousePress(event)) return;
  const list = event.currentTarget;
  const anchor = (event.target as Element).closest<HTMLElement>(ROW);
  if (!anchor || !list.contains(anchor) || !enabled(anchor)) return;
  const tick = !ticked(anchor);
  const { left, right } = anchor.getBoundingClientRect();
  const column = (left + right) / 2;
  // A row's box redraws after the click, so a row already set this drag
  // is remembered rather than read again.
  const set = new Set<HTMLElement>();
  const apply = (row: HTMLElement) => {
    if (set.has(row) || !enabled(row)) return;
    set.add(row);
    if (ticked(row) !== tick) row.click();
  };
  let last = anchor;

  const move = (e: PointerEvent) => {
    if (!(e.buttons & 1)) return end();
    // From the point, so a row scrolled out of the list's view is missed.
    const row = document
      .elementFromPoint(column, e.clientY)
      ?.closest<HTMLElement>(ROW);
    if (!row || row === last || !list.contains(row)) return;
    // A press on a row's text started selecting it, which the drag ends.
    if (!set.size) {
      window.getSelection()?.removeAllRanges();
      list.style.userSelect = "none";
    }
    const rows = [...list.querySelectorAll<HTMLElement>(ROW)];
    const at = rows.indexOf(row);
    // A virtual list may have dropped the last row by now.
    const from = rows.indexOf(last);
    const [lo, hi] =
      from < 0 ? [at, at] : [Math.min(from, at), Math.max(from, at)];
    rows.slice(lo, hi + 1).forEach(apply);
    last = row;
  };
  const up = () => {
    // Only a drag that left the pressed row has set any.
    if (set.size) {
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true));
    }
    end();
  };
  const end = () => {
    list.style.userSelect = "";
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", end);
}

// The release ends in a click on whatever is under it, which would
// toggle that row again.
function swallow(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function boxOf(row: HTMLElement): Element | null {
  return row.matches(BOX) ? row : row.querySelector(BOX);
}

// A partly ticked box reads as unticked: pressing it ticks it.
function ticked(row: HTMLElement): boolean {
  return boxOf(row)?.hasAttribute("data-checked") ?? false;
}

function enabled(row: HTMLElement): boolean {
  return !boxOf(row)?.hasAttribute("data-disabled");
}
