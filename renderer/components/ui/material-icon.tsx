import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/ui/useTheme";
import {
  iconUrl,
  resolveFileIcon,
  resolveFolderIcon,
} from "@/lib/materialIcons";

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
  const light = resolved === "light";
  const iconName =
    kind === "file"
      ? resolveFileIcon(name, light)
      : resolveFolderIcon(name, expanded);
  return (
    <img
      src={iconUrl(iconName)}
      alt=""
      draggable={false}
      className={cn("size-4 shrink-0 select-none", className)}
    />
  );
}
