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
            d="M12.2 4.5L13.6 1.7"
            stroke="currentColor"
            strokeWidth="1.05"
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

// Animal Crossing's leaf, kept to the silhouette that makes it that
// leaf: the swept tip down at the left, the big upper lobe, the notch
// the stem grows from, and the bite curling into its hook at the bottom
// right. The bite is a little smaller than the original's and the stem
// finer, which leaves the upper lobe open for the initial. The stem is
// its own stroke beside it.
const LEAF =
  "M0.2 13.6C0.9 12.4 1.2 10.6 1.6 8.9C2.1 6.5 2.7 5.2 3.3 4.3C3.3 4.3 4.7 1.9 7.8 1.9C10.5 1.95 11.5 3.7 11.7 4.1L12.5 4.7C13.6 4.7 16.1 6 16 9C15.9 12.3 13.7 13.4 13.3 13.6A2 2 0 1 0 9.6 12.8C9.6 14.1 10.7 14.8 11.5 14.75C10.7 15.1 9.6 15.2 7.5 15.2C3.6 15.2 0.7 14 0.2 13.6Z";

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
