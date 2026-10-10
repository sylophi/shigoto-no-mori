import { VillagerFaceView } from "@/components/shared/VillagerSaysView";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Resident } from "@/hooks/villagers/useResident";
import { PartyFaceView } from "./BirthdayFaceView";

// A worktree's resident (useResident) beside its branch title on the
// worktree page: whose home this is. At their `party` it wears the hat
// and throws confetti, the header's BirthdayPartyView around it. Nothing
// without a resident or a face.
export function ResidentFaceView({
  resident,
  party,
}: {
  resident: Resident | null;
  party: boolean;
}) {
  if (resident === null || resident.face === null) return null;
  const { face, profile, rarity } = resident;
  const label = party
    ? `Happy birthday, ${profile.name}!`
    : `${profile.name} lives here`;
  return (
    <SimpleTooltip tip={label}>
      <span role="img" aria-label={label} className="shrink-0">
        {party ? (
          <PartyFaceView face={face} rarity={rarity} className="size-8" />
        ) : (
          <VillagerFaceView face={face} className="size-8" />
        )}
      </span>
    </SimpleTooltip>
  );
}
