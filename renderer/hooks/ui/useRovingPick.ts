// Arrow keys over a one-row pick (a page's device tabs, the sidebar's
// device filter): Left and Right move the pick along `ids`, wrapping,
// and focus follows it once the new item is the focusable one. The
// items rove their tabindex (only the picked one is in the tab order),
// so the row needs no focus stop of its own. The handler goes on the
// items themselves.
//
// The picked item is also kept in view within the row alone, by the
// row's own inset (not scrollIntoView, which would also pull every
// scrolling ancestor): on a pick (a route that opens on the last of
// many devices, an arrow walking past the edge), when the row reorders
// around it (a peer dropping offline moves to the end), and when the
// row itself changes width (a window narrowed after the pick).
import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

export interface RovingPick {
  listRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent) => void;
}

function reveal(list: HTMLElement, pickedSelector: string) {
  const item = list.querySelector<HTMLElement>(pickedSelector);
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

export function useRovingPick({
  ids,
  selectedId,
  onSelect,
  pickedSelector,
}: {
  ids: readonly string[];
  selectedId: string;
  onSelect: (id: string) => void;
  // How the row marks its picked item: '[aria-selected="true"]' on
  // tabs, '[aria-checked="true"]' on radios.
  pickedSelector: string;
}): RovingPick {
  const listRef = useRef<HTMLDivElement>(null);

  const order = ids.join(" ");
  useEffect(() => {
    if (listRef.current) reveal(listRef.current, pickedSelector);
  }, [selectedId, order, pickedSelector]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => reveal(list, pickedSelector));
    observer.observe(list);
    return () => observer.disconnect();
  }, [pickedSelector]);

  const onKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = ids.indexOf(selectedId);
    const next = ids[(index + step + ids.length) % ids.length];
    if (next === undefined) return;
    onSelect(next);
    // Focus follows the pick once the new item is the focusable one.
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(pickedSelector)?.focus();
    });
  };

  return { listRef, onKeyDown };
}
