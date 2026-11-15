import { sidebarSideOf } from "@shigomori/ui/lib/platform.ts";
import { pageRoot } from "@/lib/themeRoot";
import { setSidebarWidth } from "@/store/layout";

// The sidebar's separator dragged: the sidebar runs from its edge of the
// window to the pointer.
export function startSidebarResize(e: React.MouseEvent): void {
  e.preventDefault();
  const left = sidebarSideOf(pageRoot()) === "left";
  const onMove = (ev: MouseEvent) =>
    setSidebarWidth(left ? ev.clientX : window.innerWidth - ev.clientX);
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
