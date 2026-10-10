import type { Dispatch, SetStateAction } from "react";
import { SectionIntro } from "@/components/ui/section-heading";
import { ToggleRowView } from "@/components/shared/ToggleRowView";
import type { SettingsFormState } from "@/hooks/config/settingsForm";
import { fieldSetter } from "@/hooks/ui/useDirtyForm";

// The desktop's notices about agent sessions (lib/agentWatch.ts), in
// Appearance: settings of this window, saved with the rest of the local
// form. Only the desktop has a system to notify through.
export function NotificationsSectionView({
  form,
  setForm,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const setField = fieldSetter(setForm);
  return (
    <section className="space-y-3">
      <SectionIntro title="System notifications">
        Sent while this window is in the background, about the coding agents in
        the worktrees it shows.
      </SectionIntro>
      <ToggleRowView
        checked={form.notifyAgentWaiting}
        onCheckedChange={setField("notifyAgentWaiting")}
        label="When an agent needs you"
        description="A permission prompt or a question, with what it asks."
      />
      <ToggleRowView
        checked={form.notifyAgentDone}
        onCheckedChange={setField("notifyAgentDone")}
        label="When an agent finishes its turn"
        description="With the message it ended on."
      />
    </section>
  );
}
