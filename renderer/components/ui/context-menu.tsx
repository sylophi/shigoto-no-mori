// oxlint-disable-next-line no-restricted-imports -- React is used as a type-only namespace
import type * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { MenuPopupSurface } from "./dropdown-menu";

// Right-click flavour of ui/dropdown-menu. Base UI's ContextMenu differs
// from Menu only in its Root (anchors at the pointer) and Trigger (opens
// on contextmenu / long press); every part below those is the same Menu
// part. So this file stops at those two, and the popup, items,
// separators, groups and labels come from ui/dropdown-menu -- same
// components, same data-slots, so doubutsu's menu hooks apply without a
// second entry.

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root {...props} />;
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

// No placement props: left unset, Base UI puts the first item under the
// pointer, the way native context menus land.
function ContextMenuContent(
  props: React.ComponentProps<typeof MenuPopupSurface>,
) {
  return <MenuPopupSurface {...props} />;
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent };
