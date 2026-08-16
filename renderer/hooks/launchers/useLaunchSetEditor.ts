import type { Dispatch, SetStateAction } from "react";
import type { LaunchSet } from "@shared/schemas";

interface LaunchSetFormShape {
  launchSets: LaunchSet[];
  // Which set auto-runs on create; null = none. Only one set can hold
  // the slot, so the editor treats the switches as a radio group.
  autoLaunchSetId: string | null;
}

// Replaces one set in place, leaving the form's other fields alone.
function mapSet<F extends LaunchSetFormShape>(
  prev: F,
  setId: string,
  update: (set: LaunchSet) => LaunchSet,
): F {
  return {
    ...prev,
    launchSets: prev.launchSets.map((s) => (s.id === setId ? update(s) : s)),
  };
}

// Mutates `launchSets` / `autoLaunchSetId` on whatever form shape
// carries them -- same contract as useLauncherListEditor, which handles
// the sibling `launchers` list. React Compiler memoizes the returned
// callbacks so no useCallback here.
export function useLaunchSetEditor<F extends LaunchSetFormShape>(
  setForm: Dispatch<SetStateAction<F>>,
) {
  const addSet = () => {
    setForm((prev) => ({
      ...prev,
      launchSets: [
        ...prev.launchSets,
        { id: crypto.randomUUID(), label: "", launcherIds: [] },
      ],
    }));
  };

  const renameSet = (setId: string, label: string) => {
    setForm((prev) => mapSet(prev, setId, (s) => ({ ...s, label })));
  };

  const removeSet = (setId: string) => {
    setForm((prev) => ({
      ...prev,
      launchSets: prev.launchSets.filter((s) => s.id !== setId),
      autoLaunchSetId:
        prev.autoLaunchSetId === setId ? null : prev.autoLaunchSetId,
    }));
  };

  // Members are unique within a set: a second copy of the same tool
  // would just re-open the window that's already there.
  const addMember = (setId: string, launcherId: string) => {
    setForm((prev) =>
      mapSet(prev, setId, (s) =>
        s.launcherIds.includes(launcherId)
          ? s
          : { ...s, launcherIds: [...s.launcherIds, launcherId] },
      ),
    );
  };

  const removeMember = (setId: string, launcherId: string) => {
    setForm((prev) =>
      mapSet(prev, setId, (s) => ({
        ...s,
        launcherIds: s.launcherIds.filter((id) => id !== launcherId),
      })),
    );
  };

  // Drag-reorder: lift `draggedId` out and drop it where `targetId`
  // sits, matching how the sidebar's project reorder reads its dnd-kit
  // event (ids, not indices).
  const moveMember = (setId: string, draggedId: string, targetId: string) => {
    setForm((prev) =>
      mapSet(prev, setId, (s) => {
        const from = s.launcherIds.indexOf(draggedId);
        const to = s.launcherIds.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return s;
        const launcherIds = [...s.launcherIds];
        launcherIds.splice(from, 1);
        launcherIds.splice(to, 0, draggedId);
        return { ...s, launcherIds };
      }),
    );
  };

  const setAutoLaunch = (setId: string, enabled: boolean) => {
    setForm((prev) => ({
      ...prev,
      autoLaunchSetId: enabled ? setId : null,
    }));
  };

  return {
    addSet,
    renameSet,
    removeSet,
    addMember,
    removeMember,
    moveMember,
    setAutoLaunch,
  };
}
