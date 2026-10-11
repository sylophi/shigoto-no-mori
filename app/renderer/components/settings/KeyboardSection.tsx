// Settings' Keyboard section (KeyboardSectionView) over the form's
// staged bindings, saved with the rest of the local form. Recording
// takes the next keys pressed, ahead of everything else in the window
// (useKeymapRecording), and refuses keys an action that can hear them
// already holds.
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  bindingOf,
  type Chord,
  chordOfPress,
  conflictOf,
  keymapGroups,
  withBinding,
} from "@shigomori/ui/lib/keymap.ts";
import type { SettingsFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { KeyboardSectionView } from "@shigomori/ui/views/settings/KeyboardSectionView.tsx";
import { isMac, keymapOf, useKeymapRecording } from "@/hooks/ui/useKeymap";

export function KeyboardSection({
  form,
  setForm,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const [recording, setRecording] = useState<string | null>(null);
  const [refused, setRefused] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const keymap = keymapOf(form.keybindings);
  useKeymapRecording(recording !== null);

  const bind = (id: string, chord: Chord | null) =>
    setForm((prev) => ({
      ...prev,
      keybindings: withBinding(prev.keybindings, id, chord),
    }));

  useEffect(() => {
    if (recording === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || e.isComposing) return;
      if (
        e.key === "Escape" &&
        !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
      ) {
        setRecording(null);
        return;
      }
      // A modifier alone waits for the key it modifies.
      const chord = chordOfPress(e, isMac);
      if (chord === null) return;
      setRecording(null);
      const holder = conflictOf(keymap, recording, chord, isMac);
      if (holder) {
        setRefused({
          id: recording,
          message: `${bindingOf(chord, isMac).label} is taken by “${holder.label}”.`,
        });
        return;
      }
      bind(recording, chord);
    };
    // A click anywhere but on the keys being recorded stops recording.
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest('[aria-pressed="true"]')) setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  });

  return (
    <KeyboardSectionView
      groups={keymapGroups(keymap)}
      recording={recording}
      refused={refused}
      onRecord={(id) => {
        setRefused(null);
        setRecording(recording === id ? null : id);
      }}
      onReset={(id) => {
        setRefused(null);
        bind(id, null);
      }}
      onResetAll={() => {
        setRefused(null);
        setRecording(null);
        setForm((prev) => ({ ...prev, keybindings: {} }));
      }}
    />
  );
}
