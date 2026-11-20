import { type Dispatch, type SetStateAction, useId } from "react";
import type { ShowDeviceIcons } from "@shigomori/contracts/schemas";
import { SectionHeading } from "../../primitives/section-heading.tsx";
import {
  SegmentedControl,
  type SegmentedOption,
} from "../../primitives/segmented-control.tsx";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";
import type { ClientFormState } from "../../lib/settingsForm.ts";
import { fieldSetter } from "../../hooks/useDirtyForm.ts";
import { cn } from "../../lib/utils.ts";

const DEVICE_ICONS: SegmentedOption<ShowDeviceIcons>[] = [
  { value: "none", label: "None" },
  { value: "worktrees", label: "Worktrees" },
  { value: "all", label: "Worktrees and projects" },
];

// How the sidebar dresses its rows, in Appearance: settings of this
// window, saved with its other settings. A row with nothing to mark is
// locked and reads off, whatever it stores, the way Village life does
// without its data.
export function SidebarSectionView({
  form,
  setForm,
  signedIn,
  terrierOn,
}: {
  form: ClientFormState;
  setForm: Dispatch<SetStateAction<ClientFormState>>;
  // Signed out, this machine is the only device, and a badge only
  // tells devices apart.
  signedIn: boolean;
  // Terrier lists its projects here, so there is something to mark.
  terrierOn: boolean;
}) {
  const setField = fieldSetter(setForm);
  const deviceIconsHint = useId();
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Sidebar</SectionHeading>
      <ToggleRowView
        checked={form.inlineWorktrees}
        onCheckedChange={setField("inlineWorktrees")}
        label="Show worktrees inline"
        description="Lists every project's worktrees under it, instead of one project at a time."
      />
      <div className="space-y-2 pl-11">
        <div className={cn("flex flex-col", !signedIn && "opacity-50")}>
          <span className="text-sm">Show device icons</span>
          <span id={deviceIconsHint} className="text-xs text-muted-foreground">
            {signedIn
              ? "Marks rows with the other devices they're on."
              : "Sign in to see which of your devices each project and worktree is on."}
          </span>
        </div>
        <SegmentedControl
          aria-label="Show device icons"
          aria-describedby={deviceIconsHint}
          value={signedIn ? form.showDeviceIcons : "none"}
          onChange={setField("showDeviceIcons")}
          options={DEVICE_ICONS}
          disabled={!signedIn}
          optionClassName="px-3 py-1.5 text-xs"
        />
      </div>
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
