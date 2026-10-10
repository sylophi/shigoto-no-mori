import type { Dispatch, SetStateAction } from "react";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { ToggleRowView } from "@/components/shared/ToggleRowView";
import type { SettingsFormState } from "@/hooks/config/settingsForm";
import { fieldSetter } from "@/hooks/ui/useDirtyForm";

// How the sidebar dresses its rows, in Appearance: settings of this
// window, saved with the rest of the local form. A row with nothing to
// mark is locked and reads off, whatever it stores, the way Village
// life does without its data.
export function SidebarSectionView({
  form,
  setForm,
  signedIn,
  terrierOn,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
  // Signed out, this machine is the only device, and a badge only
  // tells devices apart.
  signedIn: boolean;
  // Terrier lists its projects here, so there is something to mark.
  terrierOn: boolean;
}) {
  const setField = fieldSetter(setForm);
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Sidebar</SectionHeading>
      <ToggleRowView
        checked={form.inlineWorktrees}
        onCheckedChange={setField("inlineWorktrees")}
        label="Show worktrees inline"
        description="Lists every project's worktrees under it, instead of one project at a time."
      />
      <ToggleRowView
        checked={signedIn && form.showDeviceBadges}
        onCheckedChange={setField("showDeviceBadges")}
        disabled={!signedIn}
        label="Show device icons"
        description={
          signedIn
            ? "Badges open projects and each worktree with the devices they live on. Turn off for quieter rows. The device filter still narrows the list."
            : "Sign in to bring in your other devices. Open projects and each worktree are then badged with the devices they live on."
        }
      />
      <ToggleRowView
        checked={terrierOn && form.markTerrierProjects}
        onCheckedChange={setField("markTerrierProjects")}
        disabled={!terrierOn}
        label="Mark terrier projects"
        description={
          terrierOn
            ? "Shows a paw beside an open project's name when it comes from the terrier registry, so it stands apart from the ones added here."
            : "Turn on Automatically use terrier in this device's settings to list terrier's projects, then mark them here."
        }
      />
      <ToggleRowView
        checked={form.allowAgentWorking}
        onCheckedChange={setField("allowAgentWorking")}
        label="Shelve worktrees agents are working in"
        description="A worktree waits on its own folded shelf while an agent's turn runs in it. Agents report their turns through the hooks in Integrations."
      />
      <ToggleRowView
        checked={form.markAgentsWaiting}
        onCheckedChange={setField("markAgentsWaiting")}
        label="Mark worktrees whose agent needs you"
        description="While an agent waits on a permission prompt or a question, with what it asks in its tooltip."
      />
    </section>
  );
}
