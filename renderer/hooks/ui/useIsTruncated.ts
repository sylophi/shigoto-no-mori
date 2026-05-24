import { useLayoutEffect, useRef, useState } from "react";

// Reports whether an element's content is overflowing its box (i.e. the
// `truncate` ellipsis has kicked in). Re-checks on size changes via
// ResizeObserver, so it tracks sidebar resizes and font metrics changes.
export function useIsTruncated<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  boolean,
] {
  const ref = useRef<T | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, truncated];
}
