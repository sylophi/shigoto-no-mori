import { useState } from "react";

// Tracks a form value against its last-saved snapshot. Dirty detection
// is a JSON.stringify comparison, which is fine for the shallow,
// JSON-serializable shapes we use in settings/configure forms.
export function useDirtyForm<T>(initial: T) {
  const [form, setForm] = useState<T>(initial);
  const [savedSnapshot, setSavedSnapshot] = useState<T>(initial);
  const isDirty = JSON.stringify(form) !== JSON.stringify(savedSnapshot);

  // Rebase onto a value that changed underneath the form (e.g. main
  // rewrote the config while a draft was open). Clean form: adopt `next`
  // wholesale. Dirty form: move the snapshot to `next` so Save diffs
  // against reality instead of a stale baseline, and let the caller merge
  // the remote change into the draft.
  const reseed = (
    next: T,
    mergeWhenDirty?: (prevForm: T, prevSnapshot: T, next: T) => T,
  ): void => {
    if (JSON.stringify(next) === JSON.stringify(savedSnapshot)) return;
    if (!isDirty) {
      setForm(next);
    } else if (mergeWhenDirty) {
      setForm((prev) => mergeWhenDirty(prev, savedSnapshot, next));
    }
    setSavedSnapshot(next);
  };

  return { form, setForm, savedSnapshot, setSavedSnapshot, isDirty, reseed };
}
