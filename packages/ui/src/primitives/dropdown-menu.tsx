import type { ComponentProps } from "react";
import { createContext, use, type ReactNode } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { destructiveMark } from "../lib/usersAlone.ts";
import { cn } from "../lib/utils.ts";
import {
  FLOATING_POSITIONER_CLASS,
  FLOATING_SURFACE_CLASS,
} from "./floating-surface.ts";
import { ChevronRightIcon, CheckIcon } from "lucide-react";
import type { WithoutTitle } from "./tooltip.tsx";
import { useThemeRoot } from "../root.tsx";

const MENU_SURFACE_CLASS = cn(FLOATING_SURFACE_CLASS, "overflow-x-hidden");
const MENU_LABEL_CLASS =
  "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7";
const MENU_ITEM_CLASS =
  "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-6 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:cursor-not-allowed data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-[variant=destructive]:*:[svg]:text-destructive";
const MENU_SUB_TRIGGER_CLASS =
  "flex cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-6 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:data-popup-open:bg-destructive/10 data-[variant=destructive]:data-popup-open:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 dark:data-[variant=destructive]:data-popup-open:bg-destructive/20";
const MENU_RADIO_ITEM_CLASS =
  "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-2 text-xs outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-6 data-disabled:cursor-not-allowed data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";
const MENU_CHECKBOX_ITEM_CLASS =
  "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-2 text-xs outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";
const MENU_SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-border";

// A menu drawn open in place, for a scene (src/scenes): Base UI's parts
// need an open menu and a portal, neither of which draws on a server,
// so under this surface the parts below draw their own markup, with the
// live menu's slots and classes. Placed by its parent, where the live
// one floats under its trigger.
const StaticMenuContext = createContext(false);

export function StaticMenu({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <StaticMenuContext value={true}>
      <div
        role="menu"
        data-slot="dropdown-menu-content"
        data-open=""
        data-side="bottom"
        className={cn(MENU_SURFACE_CLASS, className)}
      >
        {children}
      </div>
    </StaticMenuContext>
  );
}

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

// No data-slot: Base UI merges a trigger's props over the element in
// its render prop, so a slot set here would replace the rendered
// Button's data-slot="button", and doubutsu.css would stop styling it
// as a button.
function DropdownMenuTrigger({
  ...props
}: WithoutTitle<MenuPrimitive.Trigger.Props>) {
  return <MenuPrimitive.Trigger {...props} />;
}

type MenuPopupSurfaceProps = MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >;

// Portal, Positioner, Popup: the surface every menu popup renders.
// Base UI's ContextMenu parts are the same components, so
// primitives/context-menu.tsx renders this too, with placement left unset,
// which is how Base UI knows to anchor at the pointer. It sets no
// minimum width, so a menu is as wide as its widest item.
export function MenuPopupSurface({
  align,
  alignOffset,
  side,
  sideOffset,
  className,
  ...props
}: MenuPopupSurfaceProps) {
  return (
    <MenuPrimitive.Portal container={useThemeRoot()}>
      <MenuPrimitive.Positioner
        className={FLOATING_POSITIONER_CLASS}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(MENU_SURFACE_CLASS, className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: MenuPopupSurfaceProps) {
  return (
    <MenuPopupSurface
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  if (use(StaticMenuContext)) {
    return (
      <div role="group" data-slot="dropdown-menu-group">
        {props.children as ReactNode}
      </div>
    );
  }
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  ...props
}: MenuPrimitive.GroupLabel.Props) {
  if (use(StaticMenuContext)) {
    return (
      <div
        data-slot="dropdown-menu-label"
        className={cn(MENU_LABEL_CLASS, className as string)}
      >
        {props.children as ReactNode}
      </div>
    );
  }
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn(MENU_LABEL_CLASS, className)}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: WithoutTitle<MenuPrimitive.Item.Props> & {
  variant?: "default" | "destructive";
}) {
  if (use(StaticMenuContext)) {
    return (
      <div
        role="menuitem"
        data-slot="dropdown-menu-item"
        data-variant={variant}
        {...destructiveMark(variant)}
        className={cn(MENU_ITEM_CLASS, className as string)}
      >
        {props.children as ReactNode}
      </div>
    );
  }
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      {...destructiveMark(variant)}
      className={cn(MENU_ITEM_CLASS, className)}
      {...props}
    />
  );
}

// The label of an item that asks for a second click, swapping to its
// confirm prompt once armed. Both are laid out, one hidden, so the
// menu keeps its width through the swap.
function DropdownMenuArmedLabel({
  armed,
  label,
  armedLabel,
}: {
  armed: boolean;
  label: ReactNode;
  armedLabel: ReactNode;
}) {
  return (
    <span className="grid *:col-start-1 *:row-start-1 *:flex *:items-center *:gap-1.5">
      <span className={cn(armed && "invisible")}>{label}</span>
      <span className={cn(!armed && "invisible")}>{armedLabel}</span>
    </span>
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  if (use(StaticMenuContext)) return props.children as ReactNode;
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  variant = "default",
  children,
  ...props
}: WithoutTitle<MenuPrimitive.SubmenuTrigger.Props> & {
  variant?: "default" | "destructive";
}) {
  if (use(StaticMenuContext)) {
    return (
      <div
        role="menuitem"
        data-slot="dropdown-menu-sub-trigger"
        data-variant={variant}
        {...destructiveMark(variant)}
        className={cn(MENU_SUB_TRIGGER_CLASS, className as string)}
      >
        {children as ReactNode}
        <ChevronRightIcon className="ml-auto" />
      </div>
    );
  }
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-variant={variant}
      {...destructiveMark(variant)}
      className={cn(MENU_SUB_TRIGGER_CLASS, className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: ComponentProps<typeof DropdownMenuContent>) {
  if (use(StaticMenuContext)) return null;
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn("shadow-lg", className)}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: WithoutTitle<MenuPrimitive.RadioItem.Props>) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(MENU_RADIO_ITEM_CLASS, className)}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

// An item that is on or off, its check at the end. Sized like the
// plain item, since it sits in the same lists.
function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: WithoutTitle<MenuPrimitive.CheckboxItem.Props>) {
  const isStatic = use(StaticMenuContext);
  const check = (
    <span className="pointer-events-none absolute right-2 flex items-center justify-center">
      {isStatic ? (
        props.checked && <CheckIcon />
      ) : (
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      )}
    </span>
  );
  if (isStatic) {
    return (
      <div
        role="menuitemcheckbox"
        aria-checked={props.checked === true}
        data-slot="dropdown-menu-checkbox-item"
        className={cn(MENU_CHECKBOX_ITEM_CLASS, className as string)}
      >
        {check}
        {children as ReactNode}
      </div>
    );
  }
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(MENU_CHECKBOX_ITEM_CLASS, className)}
      {...props}
    >
      {check}
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  if (use(StaticMenuContext)) {
    return (
      <div
        aria-hidden
        data-slot="dropdown-menu-separator"
        className={cn(MENU_SEPARATOR_CLASS, className as string)}
      />
    );
  }
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_SEPARATOR_CLASS, className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuArmedLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
