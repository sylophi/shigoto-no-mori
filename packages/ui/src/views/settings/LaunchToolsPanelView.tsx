import type { Dispatch, SetStateAction } from "react";
import { Plus, SquareTerminal } from "lucide-react";
import {
  installedTerminals,
  parseLauncherId,
  type DetectedLauncher,
} from "@shigomori/contracts/schemas";
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
import type { SettingsFormState } from "../../lib/settingsForm.ts";
import { useLauncherListEditor } from "../../hooks/useLauncherListEditor.ts";
import { DetectedToolsSectionView } from "./DetectedToolsSectionView.tsx";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";

// The editor setting's value for no editor: a file opens with its
// default app.
const DEFAULT_APP = "default";

// The Launch tools tab: what the Launch section on THIS machine offers.
// The keys it edits (launchers, hiddenLaunchers, launchScripts,
// terminal, editor) live in this device's config like the per-device toggles
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
  // The app's own terminal, then the installed terminal apps, in
  // TERMINAL_IDS order, with the catalog's labels and icons.
  const terminals = [
    {
      value: "app" as const,
      label: (
        <>
          <SquareTerminal className="size-3.5" />
          In app
        </>
      ),
    },
    ...installedTerminals(detected).map(({ id, entry }) => ({
      value: id,
      label: <ToolLabel entry={entry} />,
    })),
  ];

  // The installed editors, after the default app that opens a file
  // while none is picked.
  const editors = [
    { value: DEFAULT_APP, label: "Default app" },
    ...availableTools
      .filter((t) => t.editor)
      .map((d) => ({
        value: parseLauncherId(d.id)?.id ?? d.id,
        label: <ToolLabel entry={d} />,
      })),
  ];

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

      {editors.length > 1 && (
        <section className="space-y-3">
          <SectionIntro title="Editor">
            Where files open when you double click them in a file list.
          </SectionIntro>
          <SegmentedControl
            aria-label="Editor"
            // A picked editor since uninstalled opens files with
            // the default app, so that's what reads as picked.
            value={
              editors.find((e) => e.value === form.editor)?.value ?? DEFAULT_APP
            }
            onChange={(editor) =>
              setForm((prev) => ({
                ...prev,
                editor: editor === DEFAULT_APP ? null : editor,
              }))
            }
            options={editors}
            className="flex-wrap"
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
          description="A row of the worktree's scripts under the launch tools, in the Scripts section's order, as many as fit. Under a manual order, every pinned script and only those."
        />
      </section>
    </>
  );
}

// A tool's icon and name, as a picker option.
function ToolLabel({ entry }: { entry: DetectedLauncher }) {
  return (
    <>
      <LauncherIconView entry={entry} className="size-3.5" />
      {entry.label}
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
