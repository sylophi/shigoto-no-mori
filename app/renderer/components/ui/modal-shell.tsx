import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// The open shells, bottom to top. Escape reaches the top one only, so
// a picker over a dialog closes alone and the dialog under it stays.
// A shell that owns its own Escape (closeOnEscape off) still holds the
// top, which is what keeps the one under it from closing meanwhile.
const openShells: symbol[] = [];

// Removes a closing shell's copy once its own fade and its popover's
// are done, not waiting on a spinner inside. Apart from the effect that
// makes it, so it holds the copy alone and not the tree it came from.
function fadeOut(ghost: HTMLElement) {
  const exits = [ghost, ...ghost.children].flatMap((el) => el.getAnimations());
  void Promise.allSettled(exits.map((a) => a.finished)).then(() =>
    ghost.remove(),
  );
}

interface ModalShellProps {
  // Called when the user clicks the backdrop or (default) presses Escape.
  onClose: () => void;
  // When true, Escape closes the shell. Off when a child view owns its
  // own Escape handling (e.g. multi-step flows where Escape backs out).
  closeOnEscape?: boolean;
  // What Escape does instead of closing, for a multi-step flow where it
  // backs out a stage. Taken here rather than on a handler inside: this
  // one hears the key wherever focus sits, document.body included.
  onEscape?: () => void;
  // Optional override for the popover's class list (sizing, layout).
  // Defaults to a max-w-xl column.
  popoverClassName?: string;
  children: ReactNode;
}

export function ModalShell({
  onClose,
  closeOnEscape = true,
  onEscape,
  popoverClassName,
  children,
}: ModalShellProps) {
  // Escape lives on the window, not the shell: after a click on the
  // backdrop or a gap, focus (and the keydown target) is document.body,
  // whose events never reach React's delegated handlers. Captured, so
  // it lands before any handler inside the shell.
  const onEscapeRef = useRef(onEscape ?? onClose);
  onEscapeRef.current = onEscape ?? onClose;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;
  useEffect(() => {
    const id = Symbol("modal-shell");
    openShells.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || openShells.at(-1) !== id) return;
      if (!closeOnEscapeRef.current) return;
      // A menu or a list open over the shell (a dropdown inside it)
      // takes its own Escape first: captured here, the key would close
      // the dialog under it instead.
      if (
        e.target instanceof Element &&
        e.target.closest('[role="menu"], [role="listbox"]') !== null
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onEscapeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      openShells.splice(openShells.indexOf(id), 1);
    };
  }, []);
  // The exit. Callers close a shell by unmounting it, so a copy is
  // left in its place to animate out, then removed. A copy doesn't
  // carry scroll offsets, so they're kept as the lists scroll: read on
  // close, they'd force a layout in the middle of React's commit.
  const backdropRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const scrolls = new Map<Element, [number, number]>();
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      scrolls.set(e.target, [e.target.scrollLeft, e.target.scrollTop]);
    };
    backdrop.addEventListener("scroll", onScroll, true);
    return () => {
      backdrop.removeEventListener("scroll", onScroll, true);
      // Nothing to see go: motion is reduced, or the window is hidden
      // (its fade would wait to play until it's shown again), or the
      // shell is still on its way in (a fresh copy would jump back to
      // fully open first).
      if (
        matchMedia("(prefers-reduced-motion: reduce)").matches ||
        document.hidden ||
        backdrop.getAnimations().length > 0
      ) {
        return;
      }
      const ghost = backdrop.cloneNode(true) as HTMLElement;
      ghost.inert = true;
      ghost.dataset.closed = "";
      // Where the shell was, so a dialog opening in the same commit
      // lands on top of it.
      backdrop.before(ghost);
      queueMicrotask(() => {
        // StrictMode's rehearsal unmount leaves the shell in place.
        if (backdrop.isConnected) return ghost.remove();
        if (scrolls.size > 0) {
          const originals = [...backdrop.querySelectorAll("*")];
          const copies = ghost.querySelectorAll("*");
          for (const [el, [left, top]] of scrolls) {
            copies[originals.indexOf(el)]?.scrollTo(left, top);
          }
        }
        fadeOut(ghost);
      });
    };
  }, []);
  // Portaled to <body>: the shell is fixed and z-50, but under doubutsu
  // the main canvas is its own stacking context (isolation: isolate in
  // doubutsu.css), which would trap the shell beneath the sidebar
  // header's positioned title. Mounting at the body root puts it in
  // the root context, above everything, in all four theme modes.
  return createPortal(
    <div
      ref={backdropRef}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // The before: is the 10vh a short dialog hangs from, so it doesn't
      // jump as it grows. A taller dialog eats that gap first, then caps
      // at the window, where its scrolling body takes the rest (any
      // wrappers above that body need min-h-0).
      className="group/modal fixed inset-0 z-50 flex flex-col items-center bg-background/40 p-4 backdrop-blur-[2px] duration-200 ease-(--ease-out-quart) before:h-[calc(10vh-1rem)] data-closed:animate-out data-closed:duration-150 data-closed:fade-out-0 data-closed:fill-mode-forwards motion-safe:animate-in motion-safe:fade-in-0"
    >
      <div
        data-slot="modal-shell"
        className={cn(
          "flex max-h-full w-full max-w-xl shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5 duration-200 ease-(--ease-out-quart) group-data-closed/modal:duration-150 group-data-closed/modal:fill-mode-forwards motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:slide-in-from-top-2 group-data-closed/modal:animate-out group-data-closed/modal:zoom-out-95",
          popoverClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
