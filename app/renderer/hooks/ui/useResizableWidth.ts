import { useState } from "react";
import { readStored, writeStored } from "@/lib/localStorage";

// A user-dragged pane width, clamped and remembered: mouse down on a
// separator, follow the pointer, save on release. `onMouseDown` goes on
// the separator element. The pane starts at the window's left edge (the
// app sidebar), so the width is the pointer's x.
export function useResizableWidth(options: {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
}) {
  const { storageKey, min, max, fallback } = options;
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const [width, setWidth] = useState<number>(() => {
    const raw = readStored(storageKey);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return clamp(Number.isFinite(n) ? n : fallback);
  });

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    Object.assign(document.body.style, {
      cursor: "col-resize",
      userSelect: "none",
    });
    let last = width;
    const onMove = (ev: MouseEvent) => {
      last = clamp(ev.clientX);
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
