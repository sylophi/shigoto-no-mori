import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/ui/useTheme";
import {
  iconManifestStore,
  iconUrl,
  resolveFileIcon,
  resolveFolderIcon,
} from "@/lib/materialIcons";
import { useExternalStore } from "@/store/externalStore";

interface MaterialIconProps {
  name: string;
  kind: "file" | "folder";
  expanded?: boolean;
  className?: string;
}

export function MaterialIcon({
  name,
  kind,
  expanded = false,
  className,
}: MaterialIconProps) {
  const { resolved } = useTheme();
  const manifest = useExternalStore(iconManifestStore);
  // The manifest loads with the first icon (materialIcons.ts). Until
  // it lands the icon's box is held empty, so the row does not shift
  // and no wrong icon flashes.
  if (manifest === null) {
    return <span aria-hidden className={cn("size-4 shrink-0", className)} />;
  }
  const light = resolved === "light";
  const iconName =
    kind === "file"
      ? resolveFileIcon(manifest, name, light)
      : resolveFolderIcon(manifest, name, expanded);
  return (
    <img
      src={iconUrl(iconName)}
      alt=""
      draggable={false}
      className={cn("size-4 shrink-0 select-none", className)}
    />
  );
}
