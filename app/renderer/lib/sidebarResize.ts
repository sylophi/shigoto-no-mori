import { setSidebarWidth } from "@/store/layout";

// The sidebar starts at the window's left edge, so its width is the
// pointer's x.
const onMove = (ev: MouseEvent) => setSidebarWidth(ev.clientX);

// The sidebar's separator dragged: its width follows the pointer.
export function startSidebarResize(e: React.MouseEvent): void {
  e.preventDefault();
  Object.assign(document.body.style, {
    cursor: "col-resize",
    userSelect: "none",
  });
  const onUp = () => {
    Object.assign(document.body.style, { cursor: "", userSelect: "" });
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
