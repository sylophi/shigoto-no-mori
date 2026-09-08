import { useState } from "react";
import { readStored, writeStored } from "@/lib/localStorage";

// A user-dragged pane width, clamped and remembered. The app sidebar
// and the diff rail both do this: mouse down on a separator, follow the
// pointer, save on release. `onMouseDown` goes on the separator element.
export function useResizableWidth(options: {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
  // The width is the pointer's distance from this edge of the pane.
  // The sidebar starts at the window's left edge (0). A pane further in
  // passes the left edge of the element being resized.
  leftEdge: () => number;
}) {
  const { storageKey, min, max, fallback, leftEdge } = options;
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const [width, setWidth] = useState<number>(() => {
    const raw = readStored(storageKey);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? clamp(n) : fallback;
  });

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    Object.assign(document.body.style, {
      cursor: "col-resize",
      userSelect: "none",
    });
    const left = leftEdge();
    let last = width;
    const onMove = (ev: MouseEvent) => {
      last = clamp(ev.clientX - left);
      setWidth(last);
    };
    const onUp = () => {
      Object.assign(document.body.style, { cursor: "", userSelect: "" });
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      writeStored(storageKey, String(Math.round(last)));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return { width, onMouseDown };
}
