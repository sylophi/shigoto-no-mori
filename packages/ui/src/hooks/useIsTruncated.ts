import { useLayoutEffect, useRef, useState } from "react";

// Whether an element's content overflows its box: a `truncate` ellipsis
// or a `line-clamp`. A pixel of slack on height: a fractional line box
// (leading-snug on text-xs) rounds the two heights apart without any
// overflow.
export function isTruncated(el: Element): boolean {
  return (
    el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1
  );
}

// Reports whether an element's content is overflowing its box (i.e. the
// `truncate` ellipsis or a `line-clamp` has kicked in). Re-checks on
// size changes via ResizeObserver, so it tracks sidebar resizes and font
// metrics changes, and on `content` changes, which can overflow a box
// that keeps its size.
export function useIsTruncated<T extends HTMLElement>(
  content?: unknown,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(isTruncated(el));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content]);

  return [ref, truncated];
}
