import type { Dispatch, SetStateAction } from "react";
import { useAccountStatus } from "@/hooks/account/useAccount";
import type { SettingsFormState } from "@shigomori/ui/views/settings/settingsForm.ts";
import { terrierMarksHere } from "@/hooks/config/useSidebarMarks";
import { SidebarSectionView } from "@shigomori/ui/views/settings/SidebarSectionView.tsx";

// The sidebar settings (SidebarSectionView), with what the account and
// this device's terrier switch allow.
export function SidebarSection(props: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const { data: status } = useAccountStatus();
  return (
    <SidebarSectionView
      {...props}
      // Unlocked while the status loads, so a signed-in window never
      // flashes the lock.
      signedIn={status?.signedIn !== false}
      // Read off the terrier toggle as staged in this same form (the
      // device's own section), so switching it on there unlocks this
      // at once.
      terrierOn={terrierMarksHere(props.form.terrier)}
    />
  );
}
