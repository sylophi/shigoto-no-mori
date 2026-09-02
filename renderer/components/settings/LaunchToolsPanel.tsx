import type { Dispatch, SetStateAction } from "react";
import { Plus } from "lucide-react";
import type { DetectedLauncher } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { LauncherIcon } from "@/components/LauncherIcon";
import { SectionHeading } from "@/components/ui/section-heading";
import { CustomLauncherInput } from "@/components/shared/CustomLauncherInput";
import type { SettingsFormState } from "@/hooks/config/useSettingsSave";
import { useDetectedLaunchers } from "@/hooks/launchers/useLaunchers";
import { useLauncherListEditor } from "@/hooks/launchers/useLauncherListEditor";
import { DetectedToolsSection } from "./DetectedToolsSection";
import { ToggleRow } from "./ToggleRow";

// The Launch tools tab: what the Launch section on THIS machine offers.
// The keys it edits (launchers, hiddenLaunchers, launchScripts) live in
// this device's config like the per-device toggles do, but launching
// is local by nature (a tool is detected here and opens here), so the
// page files them under "Visual" and never offers them for a peer.
export function LaunchToolsPanel({
  form,
  setForm,
}: {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}) {
  const { data: detected = [] } = useDetectedLaunchers();
  const availableTools = detected.filter((d) => d.available);
  const missingTools = detected.filter((d) => !d.available);

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
      <DetectedToolsSection
        tools={availableTools}
        hidden={form.hiddenLaunchers}
        onToggle={toggleToolHidden}
      />

      {missingTools.length > 0 && (
        <section className="space-y-4">
          <div>
            <SectionHeading className="mb-1">Supported tools</SectionHeading>
            <p className="text-xs text-muted-foreground">
              Shigomori knows how to open worktrees in these too. Install any of
              them and they&apos;ll show up under detected.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {missingTools.map((d) => (
              <ToolPill key={d.id} entry={d} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div>
          <SectionHeading className="mb-1">Custom tools</SectionHeading>
          <p className="text-xs text-muted-foreground">
            Custom commands available in every worktree (e.g.{" "}
            <span className="font-mono">claude</span>,{" "}
            <span className="font-mono">tmux new-session</span>,{" "}
            <span className="font-mono">open .</span>
            ).
          </p>
        </div>
        {form.launchers.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">
            None yet. Add one to surface a command in every project&apos;s
            launcher row.
          </p>
        ) : (
          <div className="space-y-2">
            {form.launchers.map((launcher) => (
              <CustomLauncherInput
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
        <ToggleRow
          checked={form.launchScripts}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, launchScripts: v }))
          }
          label="Show scripts in the Launch section"
          description="Adds a row of the worktree's package.json scripts under the launch tools. Shows as many as fit on one line, ordered the same way the Scripts section sorts them."
        />
      </section>
    </>
  );
}

// Static pill for a supported-but-not-installed tool. Detected tools are
// interactive toggles instead -- see DetectedToolsSection.
function ToolPill({ entry }: { entry: DetectedLauncher }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border py-0.5 pr-2 pl-1.5 text-xs text-muted-foreground/60"
      title="Not installed"
    >
      <LauncherIcon entry={entry} className="size-3.5 opacity-60" />
      {entry.label}
    </span>
  );
}
