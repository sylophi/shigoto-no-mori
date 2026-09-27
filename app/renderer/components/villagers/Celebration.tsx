import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

// The trimmings of a villager's birthday (BirthdayBanner.tsx): bunting,
// confetti and balloons, drawn flat in the families doubutsu remaps.
// Every bit moves once or drifts slowly (keyframes in index.css), and
// all of it holds still under reduced motion.

const PENNANT_COLORS = [
  "bg-rose-500",
  "bg-amber-500",
  "bg-sky-500",
  "bg-emerald-500",
];

// A garland along the top edge: a string and a row of triangular
// pennants hanging off it, dropping in left to right. `color` makes it
// one villager's own.
export function Bunting({
  count = 24,
  color,
}: {
  count?: number;
  color?: string | null;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-4 overflow-hidden"
    >
      <span className="absolute inset-x-0 top-0 h-px bg-muted-foreground/30" />
      <span className="absolute inset-x-3 top-0 flex justify-between">
        {Array.from({ length: count }, (_, i) => {
          // Every other pennant in their own color, with one.
          const own = color && i % 2 === 0 ? color : undefined;
          return (
            <span
              key={i}
              style={{ animationDelay: `${i * 30}ms`, backgroundColor: own }}
              className={cn(
                "villager-bunting h-3.5 w-3 origin-top opacity-85 [clip-path:polygon(0_0,100%_0,50%_100%)]",
                !own && PENNANT_COLORS[i % PENNANT_COLORS.length],
              )}
            />
          );
        })}
      </span>
    </div>
  );
}

// Confetti thrown up and out from a point, each bit on its own fixed
// arc (no randomness, so every render draws the same): dx/dy where it
// lands, spin how far it turns on the way.
const BITS: { dx: number; dy: number; spin: number; delay: number }[] = [
  { dx: -22, dy: 38, spin: 200, delay: 0 },
  { dx: 14, dy: 46, spin: -160, delay: 40 },
  { dx: 38, dy: 30, spin: 260, delay: 80 },
  { dx: 60, dy: 52, spin: -220, delay: 20 },
  { dx: 84, dy: 36, spin: 180, delay: 120 },
  { dx: 106, dy: 58, spin: -300, delay: 60 },
  { dx: 128, dy: 34, spin: 240, delay: 100 },
  { dx: 150, dy: 50, spin: -180, delay: 140 },
  { dx: -8, dy: 60, spin: 320, delay: 160 },
  { dx: 72, dy: 64, spin: -260, delay: 180 },
  { dx: 176, dy: 42, spin: 200, delay: 90 },
  { dx: 30, dy: 70, spin: -140, delay: 200 },
];

// `burst` scales the throw, for a bigger party.
export function Confetti({ burst = 1 }: { burst?: number }) {
  const bits =
    burst > 1
      ? [
          ...BITS,
          ...BITS.map((bit) => ({
            ...bit,
            dx: -bit.dx,
            delay: bit.delay + 60,
          })),
        ]
      : BITS;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute top-1/2 left-1/2 z-10 motion-reduce:hidden"
    >
      {bits.map((bit, i) => (
        <span
          key={`${bit.dx}:${bit.delay}`}
          className={cn(
            "villager-confetti absolute size-1 opacity-0",
            burst > 1 && "size-1.5",
            i % 3 === 0 ? "rounded-full" : "rounded-[1px]",
            PENNANT_COLORS[i % PENNANT_COLORS.length],
          )}
          style={
            {
              "--confetti-dx": `${bit.dx * burst}px`,
              "--confetti-dy": `${bit.dy * burst}px`,
              "--confetti-spin": `${bit.spin}deg`,
              animationDelay: `${bit.delay}ms`,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

// Balloons drifting up past the banner, one of them carrying a present
// the way balloons float over an Animal Crossing island.
const BALLOONS = [
  { right: "6%", color: "fill-rose-400", delay: "0s", sway: "0s" },
  { right: "14%", color: "fill-sky-400", delay: "1.6s", sway: "0.7s" },
  {
    right: "22%",
    color: "fill-amber-400",
    delay: "0.8s",
    sway: "1.3s",
    gift: true,
  },
  { right: "31%", color: "fill-emerald-400", delay: "2.4s", sway: "0.3s" },
  { right: "40%", color: "fill-violet-400", delay: "3.2s", sway: "1s" },
];

export function Balloons() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {BALLOONS.map(({ right, color, delay, sway, gift }) => (
        <svg
          key={right}
          viewBox="0 0 20 44"
          style={{ right, animationDelay: `${delay}, ${sway}` }}
          className="villager-balloon absolute bottom-0 h-14 w-6"
        >
          <path
            d="M10 20Q7 28 11 34T10 44"
            fill="none"
            className="stroke-muted-foreground/40"
            strokeWidth="0.8"
          />
          <ellipse className={color} cx="10" cy="9.5" rx="8" ry="9.5" />
          <path className={color} d="M8.4 18.6h3.2L10 21Z" />
          {gift && (
            <g transform="translate(5 34)">
              <rect className="fill-rose-400" width="10" height="9" rx="1" />
              <rect className="fill-amber-300" x="4.2" width="1.6" height="9" />
              <rect className="fill-amber-300" y="3" width="10" height="1.6" />
            </g>
          )}
        </svg>
      ))}
    </div>
  );
}
