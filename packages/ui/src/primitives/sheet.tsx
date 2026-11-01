import type { ReactNode } from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { useThemeRoot } from "../root.tsx";

// A phone's sheet up from the bottom edge, its title for screen readers
// alone.
export function BottomSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal container={useThemeRoot()}>
        <SheetPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs" />
        <SheetPrimitive.Popup
          data-slot="sheet-content"
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col border-t bg-popover bg-clip-padding pb-[env(safe-area-inset-bottom)] text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:translate-y-[2.5rem] data-ending-style:opacity-0 data-starting-style:translate-y-[2.5rem] data-starting-style:opacity-0"
        >
          <SheetPrimitive.Title className="sr-only">
            {title}
          </SheetPrimitive.Title>
          {children}
        </SheetPrimitive.Popup>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
