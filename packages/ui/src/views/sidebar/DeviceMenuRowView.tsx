// A device as a menu item names it (a project's Remove and Add to
// device submenus): its glyph and name.
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DeviceGlyphView } from "../shared/DeviceGlyphView.tsx";

export function DeviceMenuRowView({
  icon,
  label,
}: {
  icon: DeviceIcon;
  label: string;
}) {
  return (
    <>
      <DeviceGlyphView icon={icon} className="size-3.5" />
      {label}
    </>
  );
}
