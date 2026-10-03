// A menu drawn open, for a scene (lab/scenes): the live menu's popup,
// label and items (dropdown-menu.tsx) with the same slots and classes,
// as plain elements. The live parts need an open Base UI menu and
// render into a portal, neither of which exists where a scene renders.
// Placed by its parent, where the live one floats under its trigger.
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import {
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SURFACE_CLASS,
} from "./menu-classes";

export function MenuSurfaceView({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      role="menu"
      data-slot="dropdown-menu-content"
      data-open=""
      data-side="bottom"
      className={cn(MENU_SURFACE_CLASS, className)}
      {...props}
    />
  );
}

export function MenuLabelView({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dropdown-menu-label"
      className={cn(MENU_LABEL_CLASS, className)}
      {...props}
    />
  );
}

export function MenuItemView({
  className,
  variant = "default",
  highlighted,
  ...props
}: ComponentProps<"div"> & {
  variant?: "default" | "destructive";
  // The item under the pointer, as Base UI marks it.
  highlighted?: boolean;
}) {
  return (
    <div
      role="menuitem"
      data-slot="dropdown-menu-item"
      data-variant={variant}
      data-highlighted={highlighted ? "" : undefined}
      className={cn(MENU_ITEM_CLASS, className)}
      {...props}
    />
  );
}
