// A legendary character's stationery, the paper their letters come on
// (components/villagers/VillagerLetter.tsx), the way every letter in
// Animal Crossing arrives on its own printed paper. Each is a small
// tile drawn here, used as a mask so the color stays a theme token:
// the shapes are black and only their coverage counts. Picked to fit
// the character, from what they are known for.

export interface Stationery {
  // The tile, an SVG data URL.
  tile: string;
  // Its size in px.
  size: [number, number];
  // The color it is printed in: a background utility in a raw family
  // the doubutsu look remaps, so both looks keep it in palette (and a
  // class, so Tailwind emits it).
  color: string;
  // The ink it is written and signed in: the same family, darker on
  // light paper and lighter on dark.
  ink: string;
}

// A tile of `width` by `height` px drawn with `body`, with its size.
const tile = (
  width: number,
  height: number,
  body: string,
): Pick<Stationery, "tile" | "size"> => ({
  tile: `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  )}")`,
  size: [width, height],
});

// A leaf with its midrib cut out (even-odd: a mask only reads coverage),
// lying on the diagonal.
const leaf = (x: number, y: number, r: number) =>
  `<path transform="translate(${x} ${y}) rotate(${r})" fill-rule="evenodd" d="M0-9C6-6 7 3 0 9C-7 3-6-6 0-9ZM-.6-7h1.2v13h-1.2Z"/>`;

const note = (x: number, y: number) =>
  `<g transform="translate(${x} ${y})"><ellipse cx="0" cy="8" rx="4" ry="3" transform="rotate(-20 0 8)"/><rect x="2.8" y="-6" width="1.6" height="14"/><path d="M4.4-6c3 1 5 3 4 7-1-2-2-3-4-3Z"/></g>`;

// A scallop shell: a fan on a little hinge, its ribs cut out.
const scallop = (x: number, y: number, s: number) =>
  `<path transform="translate(${x} ${y}) scale(${s})" fill-rule="evenodd" d="M0 8L-8.5-1.5Q0-11 8.5-1.5ZM-3 8.5h6v2.5h-6ZM0 6.5L-2.6-6h.8L0 5ZM0 6.5L2.6-6h-.8L0 5ZM0 6.5L-5.6-3.6l.6-.5L0 5ZM0 6.5L5.6-3.6l-.6-.5L0 5Z"/>`;

const star = (x: number, y: number, s: number) =>
  `<path transform="translate(${x} ${y}) scale(${s})" d="M0-10L2.9-3.1L10-3.1L4.3 1.2L6.5 8.1L0 3.9L-6.5 8.1L-4.3 1.2L-10-3.1L-2.9-3.1Z"/>`;

const APRON = tile(16, 16, `<rect width="5" height="16"/>`);

const STATIONERY: Record<string, Stationery> = {
  // Nook Inc.'s leaf.
  "tom-nook": {
    ...tile(48, 48, leaf(12, 12, 35) + leaf(36, 36, 35)),
    color: "bg-emerald-500",
    ink: "text-emerald-700 dark:text-emerald-300",
  },
  // Gingham, like her Resident Services desk.
  isabelle: {
    ...tile(
      16,
      16,
      `<rect width="8" height="16" fill-opacity=".5"/><rect width="16" height="8" fill-opacity=".5"/>`,
    ),
    color: "bg-amber-400",
    ink: "text-amber-700 dark:text-amber-300",
  },
  // His music.
  "kk-slider": {
    ...tile(48, 48, note(12, 8) + note(34, 30)),
    color: "bg-sky-500",
    ink: "text-sky-700 dark:text-sky-300",
  },
  // The shop aprons' stripes, one twin in each color.
  timmy: {
    ...APRON,
    color: "bg-emerald-400",
    ink: "text-emerald-700 dark:text-emerald-300",
  },
  tommy: {
    ...APRON,
    color: "bg-sky-400",
    ink: "text-sky-700 dark:text-sky-300",
  },
  // The museum's owl, up all night: crescent moons.
  blathers: {
    ...tile(
      44,
      44,
      `<path d="M14 4a8 8 0 1 0 6 14a6 6 0 1 1 -6 -14Z"/><path d="M34 26a6 6 0 1 0 4.5 10.5a4.5 4.5 0 1 1 -4.5 -10.5Z"/>`,
    ),
    color: "bg-violet-400",
    ink: "text-violet-700 dark:text-violet-300",
  },
  // The stars she wishes on.
  celeste: {
    ...tile(48, 48, star(12, 12, 0.8) + star(36, 34, 0.55)),
    color: "bg-violet-400",
    ink: "text-violet-700 dark:text-violet-300",
  },
  // A construction site's hazard stripes.
  "mr-resetti": {
    ...tile(20, 20, `<path d="M0 10L10 0H20L0 20ZM20 10V20H10Z"/>`),
    color: "bg-amber-500",
    ink: "text-amber-700 dark:text-amber-300",
  },
  // Diamonds, for the art dealer's taste.
  redd: {
    ...tile(24, 24, `<path d="M12 3L19 12L12 21L5 12Z"/>`),
    color: "bg-rose-400",
    ink: "text-rose-600 dark:text-rose-300",
  },
  // Coffee beans, split down the middle.
  brewster: {
    ...tile(
      36,
      36,
      `<path transform="rotate(-30 10 10)" fill-rule="evenodd" d="M10 3a5 7 0 1 0 0 14a5 7 0 1 0 0-14ZM9.4 4.5q2.4 5.5 0 11h1.2q2.4-5.5 0-11Z"/><path transform="rotate(25 27 27)" fill-rule="evenodd" d="M27 21.4a4 5.6 0 1 0 0 11.2a4 5.6 0 1 0 0-11.2ZM26.5 22.6q2 4.4 0 8.8h1q2-4.4 0-8.8Z"/>`,
    ),
    color: "bg-amber-600",
    ink: "text-amber-800 dark:text-amber-300",
  },
  // The sea he ferries across.
  kappn: {
    ...tile(
      32,
      16,
      `<path d="M0 9Q4 3 8 9T16 9T24 9T32 9" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round"/>`,
    ),
    color: "bg-sky-400",
    ink: "text-sky-700 dark:text-sky-300",
  },
  // Scallops.
  pascal: {
    ...tile(40, 40, `${scallop(11, 11, 1)}${scallop(30, 30, 0.7)}`),
    color: "bg-rose-400",
    ink: "text-rose-600 dark:text-rose-300",
  },
};

// The leaves again, for a legendary character added to the list before
// they get paper of their own.
export function stationeryFor(slug: string): Stationery {
  return STATIONERY[slug] ?? STATIONERY["tom-nook"];
}
