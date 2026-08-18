import { useLayoutEffect, useRef, useState } from "react";

// An element's own width, re-measured on resize. For layout that turns
// on how much room a pane actually has rather than how wide the window
// is: the sidebar is user-resizable, so a viewport breakpoint guesses
// wrong. Null until the first measurement lands.
export function useElementWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number | null,
] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
