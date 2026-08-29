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
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { useTerrierReadiness } from "@/hooks/terrier/useTerrierReadiness";
import { DetectedToolsSection } from "./DetectedToolsSection";
import { PortPoolLink } from "./PortPoolLink";
import { TerrierLink } from "./TerrierLink";
import { ToggleRow } from "./ToggleRow";

// The device-managed settings sections, shared verbatim between the
// local Settings form and the remote device settings body (v2 step 6).
// Everything here reads and writes only the device-managed keys
// on SettingsFormState, and every query it runs (tool detection,
// port-pool install check, gh readiness) goes through host-scoped
// hooks, so the same JSX answers for whichever device the surrounding
// HostScope names. Client-scoped concerns (appearance, updater,
// hosting, account, ...) stay in SettingsForm and must not move here.

interface DeviceSectionProps {
  form: SettingsFormState;
  setForm: Dispatch<SetStateAction<SettingsFormState>>;
}

// The Worktrees / Integrations / Launch toggle sections.
export function DeviceToggleSections({ form, setForm }: DeviceSectionProps) {
  const { data: portPoolInstalled = true } = usePortPoolInstalled();
  const { data: terrierReadiness } = useTerrierReadiness();
  const terrierInstalled = terrierReadiness?.installed ?? true;
  const terrierCompatible = terrierReadiness?.compatible ?? true;
  const terrierReady = terrierInstalled && terrierCompatible;
  const { data: githubCliReadiness } = useGithubCliReadiness();
  const ghInstalled = githubCliReadiness?.installed ?? true;
  const ghAuthed = githubCliReadiness?.authed ?? true;
  const ghReady = ghInstalled && ghAuthed;

  return (
    <>
      <section className="space-y-3">
        <SectionHeading className="mb-1">Worktrees</SectionHeading>
        <ToggleRow
          checked={form.deleteBranchOnRemove}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, deleteBranchOnRemove: v }))
          }
          label="Delete branch when removing worktree"
          description="Force-deletes the local branch the worktree had checked out. Remote branches aren't touched. Skipped when the branch is still in use elsewhere or is the repo's primary HEAD."
        />
      </section>

      <section className="space-y-3">
        <SectionHeading className="mb-1">Integrations</SectionHeading>
        <ToggleRow
          checked={form.githubCli && ghReady}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, githubCli: v }))
          }
          disabled={!ghReady}
          label="Use GitHub CLI"
          description={ghDescription(ghInstalled, ghAuthed)}
        />
        <ToggleRow
          checked={form.autoPopulateInstall}
          onCheckedChange={(v) =>
            setForm((prev) => ({ ...prev, autoPopulateInstall: v }))
          }
          label="Auto-populate install command"
          description="When adding a project with a package.json, seed the setup script with the detected package manager's install command (e.g. pnpm install). Only runs at project-add time, so existing projects are untouched."
        />
        <ToggleRow
          checked={form.portPool && portPoolInstalled}
          onCheckedChange={(v) => setForm((prev) => ({ ...prev, portPool: v }))}
          disabled={!portPoolInstalled}
          label="Automatically use port-pool"
          description={
            <>
              Allocates ports for new worktrees and releases them on delete.
              Activates when a project has a{" "}
              <span className="font-mono">port-pool.config.json</span>.{" "}
              <PortPoolLink>
                {portPoolInstalled
                  ? "Learn more"
                  : "Install port-pool to enable this integration."}
              </PortPoolLink>
            </>
          }
        />
        <ToggleRow
          // Shows the persisted truth and stays operable while on:
          // when terrier vanishes or drifts out of the version
          // handshake, the CLI warns "turn the toggle off in the
          // app's Settings", so the off switch must keep working.
          // Only turning it ON requires a ready binary.
          checked={form.terrier}
          onCheckedChange={(v) => setForm((prev) => ({ ...prev, terrier: v }))}
          disabled={!terrierReady && !form.terrier}
          label="Automatically use terrier"
          description={terrierDescription(
            terrierInstalled,
            terrierCompatible,
            terrierReadiness?.version,
          )}
        />
      </section>

      <section className="space-y-3">
        <SectionHeading className="mb-1">Launch</SectionHeading>
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

// The launcher-catalog sections: detected-tool visibility toggles, the
// supported-but-not-installed pills, and the custom launcher editor.
export function DeviceLauncherSections({ form, setForm }: DeviceSectionProps) {
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
              them and they'll show up under detected.
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
            None yet. Add one to surface a command in every project's launcher
            row.
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

function terrierDescription(
  installed: boolean,
  compatible: boolean,
  version: string | undefined,
): React.ReactNode {
  if (!installed) {
    return (
      <>
        <TerrierLink>Install terrier</TerrierLink> to enable this integration.
      </>
    );
  }
  if (!compatible) {
    return (
      <>
        {version ?? "The installed terrier"} isn't a version this build
        understands. Update both and try again.{" "}
        <TerrierLink>Learn more</TerrierLink>
      </>
    );
  }
  return (
    <>
      Shows every repo registered in terrier as a project. Removing one requires{" "}
      <span className="font-mono">terrier rm</span>.{" "}
      <TerrierLink>Learn more</TerrierLink>
    </>
  );
}

function ghDescription(installed: boolean, authed: boolean): React.ReactNode {
  if (!installed) {
    return (
      <>
        Install <span className="font-mono">gh</span> to enable this
        integration.
      </>
    );
  }
  if (!authed) {
    return (
      <>
        Run <span className="font-mono">gh auth login</span> to enable this
        integration.
      </>
    );
  }
  return (
    <>
      Use your authenticated <span className="font-mono">gh</span> session for
      GitHub-related actions.
    </>
  );
}
