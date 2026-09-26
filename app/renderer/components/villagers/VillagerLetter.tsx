import { type CSSProperties, useState } from "react";
import { stationeryFor } from "@/lib/villagers/stationery";
import { cn } from "@/lib/utils";
import type { MoveNews, Speaker } from "@/lib/villagerVoice";
import { CloseButton } from "./CloseButton";
import { MoveCaption } from "./VillagerDialogue";
import { TypedWords } from "./TypedWords";

// A legendary character's news: a letter on their own stationery that
// arrives as a small scene (DESIGN.md, "Village life: rarity", with the
// timings in index.css), or moving out, a farewell with their photo. A
// toast of its own (toastVillagerMove), so it draws its whole card.

// When the words start writing, in ms from the toast's arrival, once
// the letter is out of its envelope, and how fast.
const WORDS_AT = 1100;
const LETTER_MS = 22;

// The stamp's perforated edge: the content solid, and the padding
// around it bitten by a row of half circles.
const PERFORATED: CSSProperties = {
  mask: "linear-gradient(#000 0 0) content-box, radial-gradient(circle, transparent 1.9px, #000 2.3px) -4px -4px / 8px 8px padding-box",
};

export function VillagerLetter({
  news,
  speaker,
  words,
  onClose,
}: {
  news: MoveNews;
  speaker: Speaker;
  words: string;
  onClose: () => void;
}) {
  const paper = stationeryFor(speaker.slug);
  const [signed, setSigned] = useState(false);
  const [width, height] = paper.size;
  const print = {
    maskImage: paper.tile,
    maskSize: `${width}px ${height}px`,
    // A tile further out on the top and left, so the drift never
    // uncovers an edge.
    top: -height,
    left: -width,
    "--tile-x": `${width}px`,
    "--tile-y": `${height}px`,
  } as CSSProperties;
  const farewell = news.kind === "out";
  return (
    <div
      data-slot="villager-letter"
      className="relative w-[var(--width)] max-w-full pt-3 pr-2 font-sans"
    >
      <div
        data-slot="villager-letter-paper"
        className="relative overflow-hidden rounded-[18px] bg-popover px-3.5 pt-7 pb-3.5 text-popover-foreground shadow-md [perspective:700px]"
      >
        {/* The stationery's print, over the paper and under the page
            written on. */}
        <div
          aria-hidden
          style={print}
          className={cn(
            "villager-paper-drift absolute right-0 bottom-0 opacity-55",
            paper.color,
          )}
        />
        <div className="villager-rise relative rounded-xl bg-popover/90 px-4 pt-3 pb-2.5">
          <div className="pr-14">
            <MoveCaption news={news} ink={paper.ink} />
          </div>
          <p className="mt-1 bg-[linear-gradient(transparent_calc(100%-1px),color-mix(in_oklab,var(--color-amber-400)_40%,transparent)_0)] bg-size-[100%_1.75rem] text-[15px] leading-7 font-medium select-text">
            <TypedWords
              words={words}
              delayMs={WORDS_AT}
              letterMs={LETTER_MS}
              onDone={() => setSigned(true)}
            />
          </p>
          <Signature
            name={speaker.profile.name}
            ink={paper.ink}
            signed={signed}
            farewell={farewell}
          />
        </div>
        {/* The envelope it came in, its flap swinging open. */}
        <div
          aria-hidden
          className="villager-flap absolute inset-x-0 top-0 z-20 h-[62%] bg-popover [clip-path:polygon(0_0,100%_0,50%_100%)]"
        >
          <div className={cn("absolute inset-0 opacity-70", paper.color)} />
        </div>
      </div>
      {speaker.face &&
        (farewell ? (
          <Photo face={speaker.face} tint={paper.color} />
        ) : (
          <Stamp face={speaker.face} tint={paper.color} ink={paper.ink} />
        ))}
      <Sparkles />
      <CloseButton onClose={onClose} className="top-4 left-2 bg-popover/80" />
    </div>
  );
}

// The name, signed once the words are out: it writes on from the left,
// then a swash underlines it. A farewell signs off as a friend first.
function Signature({
  name,
  ink,
  signed,
  farewell,
}: {
  name: string;
  ink: string;
  signed: boolean;
  farewell: boolean;
}) {
  return (
    <div
      className={cn(
        "mt-1 flex flex-col items-end",
        ink,
        signed ? "villager-sign" : "villager-unsigned",
      )}
    >
      {farewell && (
        <span className="mr-6 -mb-0.5 text-xs font-medium opacity-80">
          Your friend,
        </span>
      )}
      <span className="relative -rotate-2 pr-1 pb-1.5">
        <span className="block text-base font-bold">{name}</span>
        {signed && (
          <svg
            aria-hidden
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            className="absolute right-0 bottom-0 h-2 w-[110%]"
          >
            <path
              className="villager-swash"
              pathLength={1}
              d="M2 7C22 2 38 9 55 6S84 2 98 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
    </div>
  );
}

// Their face as printed on a stamp or a photo: over a wash of the
// stationery's color.
function FacePrint({
  face,
  tint,
  className,
}: {
  face: string;
  tint: string;
  className: string;
}) {
  return (
    <span
      className={cn(
        "relative flex items-center justify-center overflow-hidden",
        className,
      )}
    >
      <span className={cn("absolute inset-0 opacity-30", tint)} />
      <img
        src={face}
        alt=""
        draggable={false}
        className="relative size-[86%] object-contain select-none"
      />
    </span>
  );
}

// The face on a postage stamp with perforated edges, leaning in the
// letter's corner, cancelled with a postmark of the day it came.
function Stamp({
  face,
  tint,
  ink,
}: {
  face: string;
  tint: string;
  ink: string;
}) {
  const [today] = useState(() =>
    new Date()
      .toLocaleDateString(undefined, { month: "short", day: "numeric" })
      .toUpperCase(),
  );
  return (
    <>
      <span
        data-slot="villager-stamp"
        aria-hidden
        style={PERFORATED}
        className="villager-stamp-drop absolute top-0 right-0 z-10 flex size-14 rotate-6 bg-popover p-1"
      >
        <FacePrint
          face={face}
          tint={tint}
          className="size-full rounded-[3px]"
        />
      </span>
      <svg
        aria-hidden
        viewBox="0 0 70 40"
        className={cn(
          "villager-postmark absolute top-1 right-11 z-10 h-9 w-[63px] -rotate-12 opacity-80",
          ink,
        )}
      >
        <circle
          cx="20"
          cy="20"
          r="16.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <circle
          cx="20"
          cy="20"
          r="12.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.8"
        />
        <text
          x="20"
          y="22.6"
          textAnchor="middle"
          fontSize="7"
          fontWeight="700"
          fill="currentColor"
        >
          {today}
        </text>
        <path
          d="M40 12q4-3 8 0t8 0t8 0M40 20q4-3 8 0t8 0t8 0M40 28q4-3 8 0t8 0t8 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </>
  );
}

// Their photo, the keepsake a villager leaves when they move out: a
// print with a warm border, leaning out of the letter's corner, held on
// by a strip of tape in the stationery's color.
function Photo({ face, tint }: { face: string; tint: string }) {
  return (
    <span
      data-slot="villager-photo"
      aria-hidden
      className="villager-stamp-drop absolute -top-1 right-0 z-10 rotate-6 bg-[color-mix(in_oklab,var(--color-amber-300)_16%,var(--popover))] p-1 pb-4 shadow-sm"
    >
      <FacePrint face={face} tint={tint} className="size-12 rounded-[2px]" />
      <span
        className={cn(
          "villager-tape absolute -top-1.5 left-1/2 h-3 w-8 -translate-x-1/2 -rotate-6 opacity-60",
          tint,
        )}
      />
    </span>
  );
}

// The twinkles that pop around the stamp as it lands, the four-pointed
// kind Animal Crossing sprinkles on anything special.
const SPARKLES = [
  { top: "-4px", right: "64px", size: 16, delay: "1.05s" },
  { top: "46px", right: "-8px", size: 13, delay: "1.15s" },
  { top: "-12px", right: "14px", size: 18, delay: "1.2s" },
  { top: "30px", right: "58px", size: 11, delay: "1.3s" },
];

function Sparkles() {
  return SPARKLES.map(({ top, right, size, delay }) => (
    <svg
      key={`${top}${right}`}
      aria-hidden
      viewBox="-6 -6 12 12"
      style={{ top, right, width: size, height: size, animationDelay: delay }}
      className="villager-sparkle pointer-events-none absolute z-20 text-amber-400"
    >
      <path
        d="M0-6C.6-1.6 1.6-.6 6 0C1.6.6.6 1.6 0 6C-.6 1.6-1.6.6-6 0C-1.6-.6-.6-1.6 0-6Z"
        fill="currentColor"
      />
    </svg>
  ));
}
