import type { Dispatch, SetStateAction } from "react";
import { SectionHeading } from "@/components/ui/section-heading";
import { ToggleRow } from "@/components/shared/ToggleRow";
import { useAccountStatus } from "@/hooks/account/useAccount";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { terrierMarksHere } from "@/hooks/config/useSidebarMarks";
import { fieldSetter } from "@/hooks/ui/useDirtyForm";

// How the sidebar dresses its rows, in Appearance: settings of this
// window, saved with the rest of the local form. A row with nothing to
// mark is locked and reads off, whatever it stores, the way Village
// life does without its data.
export function SidebarSection({
  form,
  setForm,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const setField = fieldSetter(setForm);
  // Signed out, this machine is the only device, and a badge only
  // tells devices apart. Unlocked while the status loads, so a
  // signed-in window never flashes the lock.
  const { data: status } = useAccountStatus();
  const signedIn = status?.signedIn !== false;
  // Read off the terrier toggle as staged in this same form (the
  // device's own section), so switching it on there unlocks this at
  // once.
  const terrierOn = terrierMarksHere(form.terrier);
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Sidebar</SectionHeading>
      <ToggleRow
        checked={signedIn && form.showDeviceBadges}
        onCheckedChange={setField("showDeviceBadges")}
        disabled={!signedIn}
        label="Show device icons"
        description={
          signedIn
            ? "Badges the open project and each worktree with the devices they live on. Turn off for quieter rows. The device filter still narrows the list."
            : "Sign in to bring in your other devices. The open project and each worktree are then badged with the devices they live on."
        }
      />
      <ToggleRow
        checked={terrierOn && form.markTerrierProjects}
        onCheckedChange={setField("markTerrierProjects")}
        disabled={!terrierOn}
        label="Mark terrier projects"
        description={
          terrierOn
            ? "Shows a paw beside the open project's name when it comes from the terrier registry, so it stands apart from the ones added here."
            : "Turn on Automatically use terrier in this device's settings to list terrier's projects, then mark them here."
        }
      />
    </section>
  );
}
