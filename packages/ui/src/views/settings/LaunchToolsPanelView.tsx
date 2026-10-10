import type { Dispatch, SetStateAction } from "react";
import { Plus } from "lucide-react";
import {
  launcherIdFor,
  TERMINAL_IDS,
  type DetectedLauncher,
} from "@shigomori/contracts/schemas/index";
import { Button } from "../../primitives/button.tsx";
import { LauncherIconView } from "../shared/LauncherIconView.tsx";
import {
  SectionHeading,
  SectionIntro,
} from "../../primitives/section-heading.tsx";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { CustomLauncherInputView } from "../shared/CustomLauncherInputView.tsx";
import { ScriptEnvPopoverView } from "../shared/ScriptEnvPopoverView.tsx";
import type { SettingsFormState } from "./settingsForm.ts";
import { useLauncherListEditor } from "../../hooks/useLauncherListEditor.ts";
import { DetectedToolsSectionView } from "./DetectedToolsSectionView.tsx";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";

// The Launch tools tab: what the Launch section on THIS machine offers.
// The keys it edits (launchers, hiddenLaunchers, launchScripts,
// terminal) live in this device's config like the per-device toggles
// do, but launching is local by nature (a tool is detected here and
// opens here), so the page files them under "Client" and never offers
// them for a peer.
// launchScripts also decides the script pills this window shows on a
// peer's worktree page, still read from this machine's config.
export function LaunchToolsPanelView({
  form,
  setForm,
  detected,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
  // The tools this machine knows of, installed or not.
  detected: readonly DetectedLauncher[];
}) {
  const availableTools = detected.filter((d) => d.available);
  const missingTools = detected.filter((d) => !d.available);
  // The installed terminals, in TERMINAL_IDS order, with the catalog's
  // labels and icons.
  const terminals = TERMINAL_IDS.flatMap((id) => {
    const d = availableTools.find((t) => t.id === launcherIdFor("app", id));
    if (d === undefined) return [];
    return [
      {
        value: id,
        label: (
          <>
            <LauncherIconView entry={d} className="size-3.5" />
            {d.label}
          </>
        ),
      },
    ];
  });

  const toggleToolHidden = (id: string) => {
    setForm((prev) => ({
      ...prev,
      hiddenLaunchers: prev.hiddenLaunchers.includes(id)
        ? prev.hiddenLaunchers.filter((h) => h !== id)
        : [...prev.hiddenLaunchers, id].toSorted(),
    }));
  };

  const { addLauncher, updateLauncher, removeLauncher } =
    useLauncherListEditor(setForm);

  return (
    <>
      <DetectedToolsSectionView
        tools={availableTools}
        hidden={form.hiddenLaunchers}
        onToggle={toggleToolHidden}
      />

      {terminals.length > 1 && (
        <section className="space-y-3">
          <SectionIntro title="Terminal">
            Where terminal tools like Claude Code and Neovim open.
          </SectionIntro>
          <SegmentedControl
            aria-label="Terminal"
            value={form.terminal}
            onChange={(terminal) => setForm((prev) => ({ ...prev, terminal }))}
            options={terminals}
            optionClassName="px-3 py-1.5 text-xs"
          />
        </section>
      )}

      {missingTools.length > 0 && (
        <section className="space-y-4">
          <SectionIntro title="Supported tools">
            Shigomori knows how to open worktrees in these too. Install any of
            them and they&apos;ll show up under detected.
          </SectionIntro>
          <div className="flex flex-wrap items-center gap-1.5">
            {missingTools.map((d) => (
              <ToolPill key={d.id} entry={d} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <SectionIntro title="Custom tools" action={<ScriptEnvPopoverView />}>
          Custom commands available in every worktree (e.g.{" "}
          <span className="font-mono">gh pr view --web</span>,{" "}
          <span className="font-mono">open .</span>
          ).
        </SectionIntro>
        {form.launchers.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">
            None yet. Add one to surface a command in every project&apos;s
            launcher row.
          </p>
        ) : (
          <div className="space-y-2">
            {form.launchers.map((launcher) => (
              <CustomLauncherInputView
                key={launcher.id}
                launcher={launcher}
                onChange={(patch) => updateLauncher(launcher.id, patch)}
                onRemove={() => removeLauncher(launcher.id)}
              />
            ))}
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={addLauncher}>
          <Plus />
          Add global launcher
        </Button>
      </section>

      <section className="space-y-3">
        <SectionHeading className="mb-1">Scripts</SectionHeading>
        <ToggleRowView
          checked={form.launchScripts}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, launchScripts: v }))
          }
          label="Show scripts in the Launch section"
          description="Adds a row of the worktree's package.json scripts under the launch tools. Shows as many as fit on one line, ordered the same way the Scripts section sorts them. Under a manual order, pinned scripts are the only ones shown, and all of them are."
        />
      </section>
    </>
  );
}

// Static pill for a supported-but-not-installed tool. Detected tools are
// interactive toggles instead. See DetectedToolsSectionView.
function ToolPill({ entry }: { entry: DetectedLauncher }) {
  return (
    <SimpleTooltip tip="Not installed">
      <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border py-0.5 pr-2 pl-1.5 text-xs text-muted-foreground/60">
        <LauncherIconView entry={entry} className="size-3.5 opacity-60" />
        {entry.label}
      </span>
    </SimpleTooltip>
  );
}
