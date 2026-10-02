import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";

// A project's icon: the logo its repo carries, or, for a repo with none,
// a tile with the name's initial in a hue drawn from the name. Keyed by
// name, so the same repo wears the same tile on every device. v1 draws
// it as a rounded square and doubutsu as a leaf (both shapes ship, and
// the theme picks one), styled through the project-tile slot in
// index.css and doubutsu.css.
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
        className={cn(base, "overflow-visible", className)}
      >
        <rect
          className="v1-only"
          width="16"
          height="16"
          rx="5"
          fill="currentColor"
        />
        <g className="doubutsu-only">
          <path d={LEAF} fill="currentColor" />
          <path
            d="M11.2 4L13 0.7"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </g>
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

// Animal Crossing's leaf, pared down to what still reads at 14px: two
// lobes, the tip down at the left, the round bite out of the bottom
// right. The stem is its own stroke beside it.
const LEAF =
  "M0.4 13.8C1.2 11 2 6.5 3.6 4.6C5.4 2.4 8.6 1.6 11.2 4C14.2 3.8 15.8 6.6 15.8 9.4C15.8 12 15.3 13.8 14.6 14.8A2.1 2.1 0 1 0 11.6 15.4C8 15.8 3.6 15.1 0.4 13.8Z";

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
