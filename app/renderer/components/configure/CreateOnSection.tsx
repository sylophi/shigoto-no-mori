// The Configure page's "Create on" pick (CreateOnSectionView), a
// shared setting across every device holding the repo. A project held
// on one device alone has nothing to pick, so the section stays out.
import {
  useQuickCreateDeviceId,
  useSetQuickCreateDevice,
} from "@/hooks/sharedSettings/useQuickCreateDevice";
import type { Project } from "@shigomori/contracts/schemas";
import {
  BLOCK_REASON,
  quickCreateTarget,
  useDeviceTargets,
} from "@/components/shared/deviceTargets";
import { CreateOnSectionView } from "@shigomori/ui/views/configure/CreateOnSectionView.tsx";

export function CreateOnSection({ project }: { project: Project }) {
  const holders = useDeviceTargets(project).filter(
    (target) => target.project !== undefined,
  );
  const picked = useQuickCreateDeviceId(project.identity);
  const setDevice = useSetQuickCreateDevice(project.identity);
  if (holders.length < 2) return null;

  // The `+` falls back to the first holder that can take a create now,
  // both when nothing is picked and while the pick is blocked (asleep,
  // no grant, its folder gone). The list ticks the pick and says so.
  const lands = quickCreateTarget(holders, picked);
  const pickedHolder = holders.find((holder) => holder.deviceId === picked);
  const pickBlocked = pickedHolder?.block !== undefined;

  return (
    <CreateOnSectionView
      holders={holders}
      blockReasons={BLOCK_REASON}
      current={picked ?? lands?.deviceId}
      waiting={
        pickBlocked && lands
          ? { picked: pickedHolder.label, fallback: lands.label }
          : null
      }
      onPick={setDevice}
    />
  );
}
