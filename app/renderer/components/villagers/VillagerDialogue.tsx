import { type CSSProperties, useState } from "react";
import { VillagerFace } from "@/components/shared/VillagerSays";
import { cn } from "@/lib/utils";
import type { MoveNews, Speaker } from "@/lib/villagerVoice";
import { CloseButton } from "./CloseButton";
import { MovingBox } from "./MovingBox";
import { TypedWords } from "./TypedWords";

// The look a character's words take on screen, shared with their
// birthday (BirthdayBanner): their color as --villager-ink (a face with
// no clear one takes amber), the name plate in it, and the cream box.
export function villagerInk(color: string | null): CSSProperties {
  return {
    "--villager-ink": color ?? "var(--color-amber-600)",
  } as CSSProperties;
}
export const NAMEPLATE =
  "absolute -rotate-3 rounded-[10px] bg-(--villager-ink) py-0.5 font-bold text-white";
export const DIALOGUE_BOX =
  "relative bg-[color-mix(in_oklab,var(--color-amber-300)_22%,var(--popover))] dark:bg-[color-mix(in_oklab,var(--color-amber-400)_9%,var(--popover))]";

// A rare character's news, the way Animal Crossing puts a character's
// words on screen: a soft cream dialogue box, their name on a plate in
// their own color leaning over its top edge, their words typed in a
// letter at a time, and the little arrow bobbing once the line is out.
// Moving out, they sit packed in a moving box. A toast of its own
// (toastVillagerMove), so it draws its whole card.
export function VillagerDialogue({
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
  const [done, setDone] = useState(false);
  return (
    <div
      data-slot="villager-dialogue"
      style={villagerInk(speaker.color)}
      className="relative w-[var(--width)] max-w-full pt-3.5 font-sans"
    >
      <span
        data-slot="villager-nameplate"
        className={cn(NAMEPLATE, "top-0 left-6 z-10 px-3 text-sm")}
      >
        {speaker.profile.name}
      </span>
      <div
        data-slot="villager-dialogue-box"
        className={cn(
          DIALOGUE_BOX,
          "flex gap-3 rounded-[28px_34px_30px_26px/26px_30px_34px_28px] px-4 pt-5 pb-4 text-popover-foreground shadow-md",
        )}
      >
        {speaker.face && (
          <span className="relative size-11 shrink-0">
            <VillagerFace face={speaker.face} className="size-11" />
            {news.kind === "out" && (
              <MovingBox className="villager-pack absolute -bottom-2 left-1/2 w-10 -translate-x-1/2" />
            )}
          </span>
        )}
        <div className="min-w-0 flex-1 pr-3">
          <p className="text-[15px] leading-snug font-medium select-text">
            <TypedWords words={words} onDone={() => setDone(true)} />
          </p>
          <MoveCaption news={news} ink="text-(--villager-ink)" />
        </div>
        {/* The arrow a finished line waits on, bobbing. */}
        <svg
          aria-hidden
          viewBox="0 0 12 9"
          className={cn(
            "absolute right-4 bottom-2.5 h-2 w-3 text-(--villager-ink) transition-opacity duration-200",
            done ? "villager-bob opacity-100" : "opacity-0",
          )}
        >
          <path
            d="M1.5 1.5h9q1.5 0 .7 1.3L7 7.6q-1 1.4-2 0L.8 2.8q-.8-1.3.7-1.3Z"
            fill="currentColor"
          />
        </svg>
        <CloseButton onClose={onClose} className="top-1.5 right-1.5" />
      </div>
    </div>
  );
}

// "Moved in on Thinkpad, holding katrina", the branch picked out in
// `ink` (a text color class) the way a dialogue picks out its key words.
export function MoveCaption({ news, ink }: { news: MoveNews; ink: string }) {
  const verb = news.kind === "in" ? "Moved in" : "Moved out";
  const where = news.device === null ? "" : ` on ${news.device}`;
  return (
    <p className="mt-1.5 truncate text-xs text-muted-foreground select-text">
      {verb}
      {where}
      {news.detail && news.branch && (
        <>
          , {news.detail.toLowerCase()}{" "}
          <span className={cn("font-mono font-medium", ink)}>
            {news.branch}
          </span>
        </>
      )}
    </p>
  );
}
