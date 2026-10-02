import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";

// A project's icon: the logo its repo carries, or, for a repo with none,
// a tile with the name's initial in a hue drawn from the name. Keyed by
// name, so the same repo wears the same tile on every device. Its look
// lives in index.css and doubutsu.css (the project-tile slot).
//
// Every project gets one, so the slot is held while the logo isn't
// known yet (see useProjectIcon): an empty box of the same size rather
// than the tile, which would flash before a logo replaced it.
//
// `deviceId` names the machine the project lives on when the caller is
// not inside that device's scope (see useProjectIcon).
export function ProjectIcon({
  projectId,
  name,
  deviceId,
  className,
}: {
  projectId: string;
  name: string;
  deviceId?: string;
  className?: string;
}) {
  const src = useProjectIcon(projectId, deviceId);
  // `className` stays last in every branch so a caller can still
  // override the defaults.
  const base = "size-3.5 shrink-0 select-none rounded-sm";
  if (src === undefined) {
    return <span aria-hidden className={cn(base, className)} />;
  }
  if (src === null) {
    return (
      <svg
        aria-hidden
        data-slot="project-tile"
        viewBox="0 0 16 16"
        style={{ "--project-hue": nameHue(name) } as CSSProperties}
        className={cn(base, "rounded-[32%]", className)}
      >
        <text
          x="8"
          y="8"
          dy="0.36em"
          textAnchor="middle"
          fontSize="10"
          fontWeight="800"
        >
          {initialOf(name)}
        </text>
      </svg>
    );
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn(base, "object-contain", className)}
    />
  );
}

// The name's first letter or digit, so ".dotfiles" reads as D rather
// than punctuation. Uppercased without the locale, so every device
// draws the same letter, and cut to one character ("ß" uppercases to
// "SS").
function initialOf(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? (Array.from(match[0].toUpperCase())[0] ?? "") : "";
}

// FNV-1a over the name, folded onto the color wheel.
function nameHue(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}
