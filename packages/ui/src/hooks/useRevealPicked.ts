// Keeps a one-row pick's picked item in view (a page's device tabs, the
// sidebar's device filter, the terminal tabs), within the row alone,
// by the row's own inset (not scrollIntoView, which would also pull
// every scrolling ancestor): on a pick (a route that opens on the last
// of many devices, an arrow walking past the edge), when the row
// reorders around it (a peer dropping offline moves to the end), and
// when the row itself changes width (a window narrowed after the pick).
// The ref goes on the row that scrolls. Base UI's Tabs and RadioGroup
// mark the picked item, and move it with the arrows.
import { useEffect, useRef, type RefObject } from "react";

const PICKED = '[aria-selected="true"], [aria-checked="true"]';

function reveal(list: HTMLElement) {
  const item = list.querySelector<HTMLElement>(PICKED);
  if (!item) return;
  const inset = parseFloat(getComputedStyle(list).paddingLeft) || 0;
  const edge = list.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  if (box.left < edge.left + inset) {
    list.scrollLeft += box.left - (edge.left + inset);
  } else if (box.right > edge.right - inset) {
    list.scrollLeft += box.right - (edge.right - inset);
  }
}

export function useRevealPicked(
  selectedId: string | null,
  ids: readonly string[],
): RefObject<HTMLDivElement | null> {
  const listRef = useRef<HTMLDivElement>(null);
  const order = ids.join(" ");
  useEffect(() => {
    if (listRef.current) reveal(listRef.current);
  }, [selectedId, order]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => reveal(list));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  return listRef;
}
