import { type CSSProperties, type ReactNode, useState } from "react";
import { VillagerFaceView } from "../shared/VillagerSaysView.tsx";
import { cn } from "../../lib/utils.ts";
import type { MoveNews, Speaker } from "../../lib/villagerVoice.ts";
import { MovingBoxView } from "./MovingBoxView.tsx";
import { NextArrowView } from "./NextArrowView.tsx";
import { TypedWordsView } from "./TypedWordsView.tsx";

// The look a character's words take on screen: their color as
// --villager-ink (a face with no clear one takes amber, and their
// birthday's wash takes it too), the name plate in it, and the cream
// box.
export function villagerInk(color: string | null): CSSProperties {
  return {
    "--villager-ink": color ?? "var(--color-amber-600)",
  } as CSSProperties;
}
const DIALOGUE_BOX =
  "relative bg-[color-mix(in_oklab,var(--color-amber-300)_22%,var(--popover))] dark:bg-[color-mix(in_oklab,var(--color-amber-400)_9%,var(--popover))]";

// A character's name on a plate in their own color (--villager-ink),
// leaning. The caller places and sizes it.
export function NameplateView({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-slot="villager-nameplate"
      className={cn(
        "-rotate-3 rounded-[10px] bg-(--villager-ink) py-0.5 font-bold text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}

// The dialogue box itself: the cream box in the character's color,
// their name plate leaning over its top edge, and their face and words
// inside, laid out by the caller. VillagerDialogueView's, and anywhere else
// a character speaks in their own box.
export function DialogueFrameView({
  name,
  color,
  className,
  children,
}: {
  name: string;
  color: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="villager-dialogue"
      style={villagerInk(color)}
      className={cn("relative max-w-full pt-3.5 font-sans", className)}
    >
      <NameplateView className="absolute top-0 left-6 z-10 px-3 text-sm">
        {name}
      </NameplateView>
      <div
        data-slot="villager-dialogue-box"
        className={cn(
          DIALOGUE_BOX,
          "flex gap-3 rounded-[28px_34px_30px_26px/26px_30px_34px_28px] px-4 pt-5 pb-4 text-popover-foreground shadow-md",
        )}
      >
        {children}
      </div>
    </div>
  );
}

// A rare character's news, the way Animal Crossing puts a character's
// words on screen: a soft cream dialogue box, their name on a plate in
// their own color leaning over its top edge, their words typed in a
// letter at a time, and the little arrow bobbing once the line is out.
// Moving out, they sit packed in a moving box. A toast of its own
// (toastVillagerMove), so it draws its whole card.
export function VillagerDialogueView({
  news,
  speaker,
  words,
}: {
  news: MoveNews;
  speaker: Speaker;
  words: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <DialogueFrameView
      name={speaker.profile.name}
      color={speaker.color}
      className="w-[var(--width)]"
    >
      {speaker.face && (
        <span className="relative size-11 shrink-0">
          <VillagerFaceView face={speaker.face} className="size-11" />
          {news.kind === "out" && (
            <MovingBoxView className="villager-pack absolute -bottom-2 left-1/2 w-10 -translate-x-1/2" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1 pr-3">
        <p className="text-[15px] leading-snug font-medium">
          <TypedWordsView words={words} onDone={() => setDone(true)} />
        </p>
        <MoveCaptionView news={news} ink="text-(--villager-ink)" />
      </div>
      <NextArrowView
        shown={done}
        className="absolute right-4 bottom-2.5 text-(--villager-ink)"
      />
    </DialogueFrameView>
  );
}

// "Moved in on Thinkpad, holding katrina", the branch picked out in
// `ink` (a text color class) the way a dialogue picks out its key words.
export function MoveCaptionView({
  news,
  ink,
}: {
  news: MoveNews;
  ink: string;
}) {
  const verb = news.kind === "in" ? "Moved in" : "Moved out";
  const where = news.device === null ? "" : ` on ${news.device}`;
  return (
    <p className="mt-1.5 truncate text-xs text-muted-foreground">
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
