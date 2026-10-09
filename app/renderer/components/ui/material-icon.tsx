import { cn } from "@/lib/utils";
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
  const manifest = useExternalStore(iconManifestStore);
  // The manifest loads with the first icon (materialIcons.ts). Until
  // it lands the icon's box is held empty, so the row does not shift
  // and no wrong icon flashes.
  if (manifest === null) {
    return <span aria-hidden className={cn("size-4 shrink-0", className)} />;
  }
  const iconFor = (light: boolean) =>
    kind === "file"
      ? resolveFileIcon(manifest, name, light)
      : resolveFolderIcon(manifest, name, expanded);
  const dark = iconFor(false);
  const light = iconFor(true);
  // A file with a light variant wears it on the light theme. The theme
  // is the dark class on the root (ThemeProvider), read here by CSS so
  // the icon needs no hook of the app's.
  if (light === dark) return <IconImage name={dark} className={className} />;
  return (
    <>
      <IconImage name={light} className={cn("dark:hidden", className)} />
      <IconImage name={dark} className={cn("hidden dark:inline", className)} />
    </>
  );
}

function IconImage({ name, className }: { name: string; className?: string }) {
  return (
    <img
      src={iconUrl(name)}
      alt=""
      draggable={false}
      className={cn("size-4 shrink-0 select-none", className)}
    />
  );
}
