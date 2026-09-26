import { useState } from "react";
import { calendarDayOf } from "@shared/villagers/birthdays";
import type { Worktree } from "@shared/schemas";
import { useToday } from "@/hooks/ui/useToday";
import { useVillagerBirthday } from "@/hooks/villagers/useVillagerBirthday";
import { printStyle, stationeryFor } from "@/lib/villagers/stationery";
import { cn } from "@/lib/utils";
import { type Speaker, villagerQuote } from "@/lib/villagerVoice";
import { BirthdayFace } from "./BirthdayFace";
import { Balloons, Bunting, Confetti } from "./Celebration";
import { CloseButton } from "./CloseButton";
import { TypedWords } from "./TypedWords";
import { DIALOGUE_BOX, NAMEPLATE, villagerInk } from "./VillagerDialogue";

// The worktree page on its villager's birthday, under the header, put
// away for the day with its X. The rarer the character, the bigger the
// party (DESIGN.md, "Village life: rarity"): a regular villager's is a
// line under bunting with a pinch of confetti, a special character says
// so in a dialogue box under bunting in their own color, and a
// household name gets balloons and a burst of confetti over their own
// stationery.

// Banners put away this session, by worktree and day: tomorrow there is
// no banner to bring back anyway.
const dismissed = new Set<string>();

export function BirthdayBanner({ worktree }: { worktree: Worktree }) {
  const villager = useVillagerBirthday(worktree, { withColor: true });
  const key = `${worktree.id}@${calendarDayOf(useToday())}`;
  const [, setDismissals] = useState(0);
  if (villager === null || dismissed.has(key)) return null;
  const dismiss = () => {
    dismissed.add(key);
    setDismissals((n) => n + 1);
  };
  const Party =
    villager.rarity === "legendary"
      ? LegendaryParty
      : villager.rarity === "rare"
        ? RareParty
        : CommonParty;
  return (
    <div
      role="status"
      data-slot="villager-birthday"
      className="relative overflow-hidden border-b border-border bg-muted/40 text-sm"
    >
      <Party villager={villager} />
      <CloseButton
        onClose={dismiss}
        className={cn(
          "top-3 right-4 z-20",
          // Over a legend's stationery, on paper like the letter's.
          villager.rarity === "legendary" && "bg-popover/80",
        )}
      />
    </div>
  );
}

function PartyFace({
  villager,
  className,
  burst,
}: {
  villager: Speaker;
  className: string;
  burst?: number;
}) {
  if (villager.face === null) return null;
  return (
    <span className="relative shrink-0">
      <BirthdayFace face={villager.face} className={className} />
      <Confetti burst={burst} />
    </span>
  );
}

function CommonParty({ villager }: { villager: Speaker }) {
  return (
    <div className="flex items-center gap-3 px-6 pt-5 pr-12 pb-2.5">
      <Bunting />
      <PartyFace villager={villager} className="size-8" />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium">
          Happy birthday, {villager.profile.name}!
        </span>{" "}
        <span className="text-muted-foreground">
          A good day to ship something nice.
        </span>
      </p>
    </div>
  );
}

// Their line in a dialogue box, the way they'd say it on the island,
// under bunting in their own color.
function RareParty({ villager }: { villager: Speaker }) {
  return (
    <div style={villagerInk(villager.color)} className="px-6 pt-6 pr-12 pb-3">
      <Bunting color={villager.color} />
      <div className="flex items-center gap-4">
        <PartyFace villager={villager} className="size-11" />
        <div
          data-slot="villager-dialogue-box"
          className={cn(
            DIALOGUE_BOX,
            "max-w-xl min-w-0 flex-1 rounded-[22px_28px_24px_20px/20px_24px_28px_22px] px-4 pt-4 pb-2.5",
          )}
        >
          <span
            data-slot="villager-nameplate"
            className={cn(NAMEPLATE, "-top-3 left-4 px-2.5 text-xs")}
          >
            {villager.profile.name}
          </span>
          <p className="text-[15px] leading-snug font-medium">
            <TypedWords words="It's my birthday today!" />
          </p>
        </div>
      </div>
    </div>
  );
}

// A party: their own stationery drifting behind, balloons floating up,
// a burst of confetti, and their face big, in its party hat.
function LegendaryParty({ villager }: { villager: Speaker }) {
  const paper = stationeryFor(villager.slug);
  const quote = villagerQuote(villager.profile);
  return (
    <div className="relative px-6 pt-7 pr-12 pb-4">
      <div
        aria-hidden
        style={printStyle(paper)}
        className={cn(
          "villager-paper-drift absolute right-0 bottom-0 opacity-25",
          paper.color,
        )}
      />
      <Balloons />
      <Bunting count={30} />
      {/* The words on a page of their own, the way the letter writes on
          one, so the print shows around them and never behind. */}
      <div className="relative flex w-fit max-w-full items-center gap-4 rounded-2xl bg-popover/90 py-2.5 pr-5 pl-3">
        <PartyFace villager={villager} className="size-14" burst={1.8} />
        <div className="min-w-0">
          <p className={cn("text-lg leading-tight font-bold", paper.ink)}>
            Happy birthday, {villager.profile.name}!
          </p>
          {quote && (
            <p className="mt-0.5 truncate text-muted-foreground">“{quote}”</p>
          )}
        </div>
      </div>
    </div>
  );
}
