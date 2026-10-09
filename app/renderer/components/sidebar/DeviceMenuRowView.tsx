// A device as a menu item names it (a project's Remove and Add to
// device submenus): its glyph and name, and a note at the item's end.
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DeviceGlyphView } from "@/components/shared/DeviceGlyphView";

export function DeviceMenuRowView({
  icon,
  label,
  note,
}: {
  icon: DeviceIcon;
  label: string;
  note?: string;
}) {
  return (
    <>
      <DeviceGlyphView icon={icon} className="size-3.5" />
      {label}
      {note !== undefined && <span className="ml-auto pl-3">{note}</span>}
    </>
  );
}
