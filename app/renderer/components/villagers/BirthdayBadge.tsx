import { Cake } from "lucide-react";
import type { Worktree } from "@shared/schemas";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { MaybeHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { useVillagerBirthday } from "@/hooks/villagers/useVillagerBirthday";
import { localDeviceId } from "@/lib/queryKeys";
import { BirthdayFace } from "./BirthdayFace";

// The cake a worktree row wears on its villager's birthday, with their
// party-hatted face in the tooltip. Nothing on any other day, or for any
// other name. `deviceId` names a peer the worktree lives on, for a row
// drawn outside that peer's HostScope: its Village life decides, and a
// peer not connected shows nothing.
export function BirthdayBadge({
  worktree,
  deviceId = localDeviceId,
}: {
  worktree: Pick<Worktree, "name" | "isPrimary">;
  deviceId?: string;
}) {
  const local = deviceId === localDeviceId;
  const api = useRemoteDeviceApi(local ? undefined : deviceId);
  if (!local && api === undefined) return null;
  return (
    <MaybeHostScope deviceId={deviceId} api={api}>
      <Badge worktree={worktree} />
    </MaybeHostScope>
  );
}

function Badge({
  worktree,
}: {
  worktree: Pick<Worktree, "name" | "isPrimary">;
}) {
  const villager = useVillagerBirthday(worktree);
  if (villager === null) return null;
  const tip = `${villager.profile.name}'s birthday today`;
  return (
    <SimpleTooltip
      tip={
        <span className="flex items-center gap-2">
          {villager.face && (
            <BirthdayFace face={villager.face} className="mt-1 size-6" />
          )}
          {tip}
        </span>
      }
    >
      <Cake
        role="img"
        aria-label={tip}
        className="size-3 shrink-0 text-amber-500"
      />
    </SimpleTooltip>
  );
}
