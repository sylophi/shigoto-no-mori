import type { Dispatch, SetStateAction } from "react";
import { useAccountStatus } from "@/hooks/account/useAccount";
import type { ClientFormState } from "@shigomori/ui/lib/settingsForm.ts";
import { terrierMarksHere } from "@/hooks/config/useSidebarMarks";
import { useHasLocalHost } from "@/lib/localHost";
import { SidebarSectionView } from "@shigomori/ui/views/settings/SidebarSectionView.tsx";

// The sidebar settings (SidebarSectionView), with what the account and
// this device's terrier switch allow.
export function SidebarSection({
  terrier,
  ...props
}: {
  form: ClientFormState;
  setForm: Dispatch<SetStateAction<ClientFormState>>;
  // This device's terrier toggle as staged, so switching it on in the
  // device's own section unlocks this at once.
  terrier: boolean;
}) {
  const { data: status } = useAccountStatus();
  return (
    <SidebarSectionView
      {...props}
      // Unlocked while the status loads, so a signed-in window never
      // flashes the lock.
      signedIn={status?.signedIn !== false}
      terrierOn={terrierMarksHere(useHasLocalHost(), terrier)}
    />
  );
}
