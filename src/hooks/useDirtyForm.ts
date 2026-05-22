import { useState } from "react";

// Tracks a form value against its last-saved snapshot. Dirty detection
// is a JSON.stringify comparison, which is fine for the shallow,
// JSON-serializable shapes we use in settings/configure forms.
export function useDirtyForm<T>(initial: T) {
  const [form, setForm] = useState<T>(initial);
  const [savedSnapshot, setSavedSnapshot] = useState<T>(initial);
  const isDirty = JSON.stringify(form) !== JSON.stringify(savedSnapshot);
  return { form, setForm, savedSnapshot, setSavedSnapshot, isDirty };
}
