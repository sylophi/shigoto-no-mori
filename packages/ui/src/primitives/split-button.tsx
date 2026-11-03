import type React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

// The main half's class. It drops its right border, so the menu half's
// left border is the seam: a hairline beside an outline, a sliver of
// the surface beside a fill.
export const SPLIT_BUTTON_MAIN = "rounded-r-none border-r-0";

// A button with a menu beside it of other ways to do what it does. The
// caller draws the main half (SPLIT_BUTTON_MAIN on it) and the items.
export function SplitButton({
  main,
  variant,
  disabled,
  menuLabel,
  children,
}: {
  main: React.ReactNode;
  variant: React.ComponentProps<typeof Button>["variant"];
  disabled: boolean;
  menuLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="inline-flex items-stretch">
      {main}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant={variant}
              disabled={disabled}
              aria-label={menuLabel}
              className="rounded-l-none px-1.5"
            >
              <ChevronDown aria-hidden className="size-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4}>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
