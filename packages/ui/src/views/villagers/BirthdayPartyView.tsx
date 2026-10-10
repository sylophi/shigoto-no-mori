import { stationeryFor } from "../../lib/villagers/stationery.ts";
import { useFaceColor } from "../../hooks/useFaceColor.ts";
import type { Resident } from "../../lib/villagerVoice.ts";
import { BalloonsView, BuntingView } from "./CelebrationView.tsx";
import { StationeryPrintView } from "./StationeryPrintView.tsx";
import { villagerInk } from "./VillagerDialogueView.tsx";

// The worktree page's header on its villager's birthday, behind the
// breadcrumb and the title, whose face (ResidentFaceView) wears the
// party hat. No words: the trimmings say it. The rarer the character,
// the bigger the party (DESIGN.md, "Village life: rarity"): bunting for
// a regular villager, bunting and a wash in their own color for a
// special character, and for a household name their own stationery
// drifting behind balloons. Fills its parent, under everything else in
// it: the parent takes PARTY_HOST. The party clips itself, so the
// face's confetti can still fall past the header.
export const PARTY_HOST = "relative isolate";

export function BirthdayPartyView({ villager }: { villager: Resident }) {
  return (
    <div
      aria-hidden
      data-slot="villager-birthday"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      {villager.rarity === "legendary" ? (
        <LegendaryTrimmings slug={villager.slug} />
      ) : villager.rarity === "rare" ? (
        <RareTrimmings face={villager.face} />
      ) : (
        <BuntingView />
      )}
    </div>
  );
}

// Their color read off their face (a face with no clear one takes
// amber), washing in from the right under their own bunting.
function RareTrimmings({ face }: { face: string | null }) {
  const color = useFaceColor(face);
  return (
    <>
      <div
        style={villagerInk(color)}
        className="absolute inset-0 bg-(--villager-ink) [mask-image:linear-gradient(to_left,black,transparent_70%)] opacity-10"
      />
      <BuntingView color={color} />
    </>
  );
}

// Their stationery on the right, fading out before the title, with
// balloons drifting up through it.
function LegendaryTrimmings({ slug }: { slug: string }) {
  const paper = stationeryFor(slug);
  return (
    <>
      <div className="absolute inset-0 [mask-image:linear-gradient(to_left,black_20%,transparent_65%)]">
        <StationeryPrintView paper={paper} className="opacity-25" />
      </div>
      <BalloonsView />
      <BuntingView count={30} />
    </>
  );
}
