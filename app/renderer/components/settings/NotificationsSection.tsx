import type { Dispatch, SetStateAction } from "react";
import { SectionIntro } from "@/components/ui/section-heading";
import { ToggleRow } from "@/components/shared/ToggleRow";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { fieldSetter } from "@/hooks/ui/useDirtyForm";

// The desktop's notices about agent sessions (lib/agentWatch.ts), in
// Appearance: settings of this window, saved with the rest of the local
// form. Only the desktop has a system to notify through.
export function NotificationsSection({
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
      <ToggleRow
        checked={form.notifyAgentWaiting}
        onCheckedChange={setField("notifyAgentWaiting")}
        label="When an agent needs you"
        description="A permission prompt or a question, with what it asks."
      />
      <ToggleRow
        checked={form.notifyAgentDone}
        onCheckedChange={setField("notifyAgentDone")}
        label="When an agent finishes its turn"
        description="With the message it ended on."
      />
    </section>
  );
}
