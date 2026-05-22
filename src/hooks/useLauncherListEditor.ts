import type { Dispatch, SetStateAction } from "react";
import type { LauncherCommand } from "@shared/schemas";

// Mutates `launchers` on whatever form shape contains it. Used by both
// the project config and the global settings forms, which carry their
// own siblings (theme, scripts, ...) on the same form state. React
// Compiler memoizes the returned callbacks so no useCallback here.
export function useLauncherListEditor<
  F extends { launchers: LauncherCommand[] },
>(setForm: Dispatch<SetStateAction<F>>) {
  const addLauncher = () => {
    setForm((prev) => ({
      ...prev,
      launchers: [
        ...prev.launchers,
        { id: crypto.randomUUID(), label: "", command: "" },
      ],
    }));
  };

  const updateLauncher = (id: string, patch: Partial<LauncherCommand>) => {
    setForm((prev) => ({
      ...prev,
      launchers: prev.launchers.map((l) =>
        l.id === id ? { ...l, ...patch } : l,
      ),
    }));
  };

  const removeLauncher = (id: string) => {
    setForm((prev) => ({
      ...prev,
      launchers: prev.launchers.filter((l) => l.id !== id),
    }));
  };

  return { addLauncher, updateLauncher, removeLauncher };
}
