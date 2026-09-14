import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// The open shells, bottom to top. Escape reaches the top one only, so
// a picker over a dialog closes alone and the dialog under it stays.
// A shell that owns its own Escape (closeOnEscape off) still holds the
// top, which is what keeps the one under it from closing meanwhile.
const openShells: symbol[] = [];

interface ModalShellProps {
  // Called when the user clicks the backdrop or (default) presses Escape.
  onClose: () => void;
  // When true, Escape closes the shell. Off when a child view owns its
  // own Escape handling (e.g. multi-step flows where Escape backs out).
  closeOnEscape?: boolean;
  // Optional override for the popover's class list (sizing, layout).
  // Defaults to the standard "centered max-w-xl" modal shape.
  popoverClassName?: string;
  children: ReactNode;
}

export function ModalShell({
  onClose,
  closeOnEscape = true,
  popoverClassName,
  children,
}: ModalShellProps) {
  // Escape lives on the window, not the shell: after a click on the
  // backdrop or a gap, focus (and the keydown target) is document.body,
  // whose events never reach React's delegated handlers. Captured, so
  // it lands before any handler inside the shell.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;
  useEffect(() => {
    const id = Symbol("modal-shell");
    openShells.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || openShells.at(-1) !== id) return;
      if (!closeOnEscapeRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      openShells.splice(openShells.indexOf(id), 1);
    };
  }, []);
  // Portaled to <body>: the shell is fixed and z-50, but under doubutsu
  // the main canvas is its own stacking context (isolation: isolate in
  // doubutsu.css), which would trap the shell beneath the sidebar
  // header's positioned title. Mounting at the body root puts it in
  // the root context, above everything, in all four theme modes.
  return createPortal(
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/40 p-4 pt-[10vh] backdrop-blur-[2px]"
    >
      <div
        data-slot="modal-shell"
        className={cn(
          "w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5",
          popoverClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
