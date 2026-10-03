// The modal shell's look: a backdrop over the window and the dialog's
// box hung from near its top. ModalShell (modal-shell.tsx) portals it
// over the app with its keys and clicks. A scene (lab/scenes) draws the
// box alone (ModalShellBox).
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ModalShellView({
  popoverClassName,
  children,
  ...backdrop
}: ComponentProps<"div"> & {
  // Optional override for the popover's class list (sizing, layout).
  // Defaults to a max-w-xl column.
  popoverClassName?: string;
}) {
  return (
    <div
      role="presentation"
      // The before: is the 10vh a short dialog hangs from, so it doesn't
      // jump as it grows. A taller dialog eats that gap first, then caps
      // at the window, where its scrolling body takes the rest (any
      // wrappers above that body need min-h-0).
      className="fixed inset-0 z-50 flex flex-col items-center bg-background/40 p-4 backdrop-blur-[2px] before:h-[calc(10vh-1rem)]"
      {...backdrop}
    >
      <ModalShellBox popoverClassName={popoverClassName}>
        {children}
      </ModalShellBox>
    </div>
  );
}

// The dialog's box alone, without the backdrop, for a scene that
// pictures the dialog itself rather than the window under it.
export function ModalShellBox({
  popoverClassName,
  children,
}: {
  popoverClassName?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-slot="modal-shell"
      className={cn(
        "flex max-h-full w-full max-w-xl shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5",
        popoverClassName,
      )}
    >
      {children}
    </div>
  );
}
