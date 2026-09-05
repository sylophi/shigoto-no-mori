import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface ModalShellProps {
  // Called when the user clicks the backdrop or (default) presses Escape.
  // Children can intercept Escape via onKeyDownCapture if they need to
  // gate dismissal on internal state.
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
  const onKeyDown = closeOnEscape
    ? (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }
    : undefined;
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
      onKeyDown={onKeyDown}
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
