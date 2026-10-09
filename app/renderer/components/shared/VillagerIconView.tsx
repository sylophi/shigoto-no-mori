import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

// A doubutsu character's bare face (VillagerIcon reads it by name slug
// from this device's villager data, gated by useVillageLife). No face
// renders nothing, never a stand-in. The fake host's contact sheet draws these. A
// product surface shows a villager through VillagerFaceView (VillagerSaysView.tsx)
// instead.
//
// `size` is in desktop pixels on the spacing scale (24 draws like
// size-6), so it grows on a phone like the size-* utilities. Leave it
// out to size with `className` (default size-6). `alt` defaults to
// empty: beside a name, the face is decoration.
export function VillagerIconView({
  src,
  size,
  alt = "",
  className,
}: {
  src: string | null;
  size?: number;
  alt?: string;
  className?: string;
}) {
  if (src === null) return null;
  const edge = `calc(var(--spacing) * ${(size ?? 0) / 4})`;
  const box: CSSProperties | undefined =
    size === undefined ? undefined : { width: edge, height: edge };
  return (
    <img
      data-slot="villager-icon"
      src={src}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      decoding="async"
      className={cn(
        "shrink-0 object-contain select-none",
        size === undefined && "size-6",
        className,
      )}
      style={box}
    />
  );
}
