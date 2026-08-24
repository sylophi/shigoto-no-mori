import { useEffect } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditorFooter } from "@/components/shared/EditorFooter";
import { ErrorBanner } from "@/components/ui/error-banner";
import { LauncherIcon } from "@/components/LauncherIcon";
import { SectionHeading } from "@/components/ui/section-heading";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useDetectedLaunchers } from "@/hooks/launchers/useLaunchers";
import {
  fromConfig,
  type SettingsFormState,
  SettingsSaveError,
  useSettingsSave,
} from "@/hooks/config/useSettingsSave";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { useLauncherListEditor } from "@/hooks/launchers/useLauncherListEditor";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { useTheme } from "@/hooks/ui/useTheme";
import type {
  ClientConfig,
  DetectedLauncher,
  GlobalConfig,
  Theme,
} from "@shared/schemas";
import { AppearanceSection } from "./AppearanceSection";
import { CustomLauncherInput } from "@/components/shared/CustomLauncherInput";
import { DangerZone } from "./DangerZone";
import { DataLocationSection } from "./DataLocationSection";
import { DetectedToolsSection } from "./DetectedToolsSection";
import { HostingSection } from "./HostingSection";
import { RemoteDevicesSection } from "./RemoteDevicesSection";
import { PortPoolLink } from "./PortPoolLink";
import { CliSection } from "./CliSection";
import { ToggleRow } from "./ToggleRow";
import { VersionSection } from "./VersionSection";

export function SettingsForm({
  initialConfig,
  initialClientConfig,
}: {
  initialConfig: GlobalConfig;
  initialClientConfig: ClientConfig;
}) {
  const { data: detected = [] } = useDetectedLaunchers();
  const { data: portPoolInstalled = true } = usePortPoolInstalled();
  const { data: githubCliReadiness } = useGithubCliReadiness();
  const ghInstalled = githubCliReadiness?.installed ?? true;
  const ghAuthed = githubCliReadiness?.authed ?? true;
  const ghReady = ghInstalled && ghAuthed;
  const save = useSettingsSave({ initialConfig, initialClientConfig });
  const { setOverride } = useTheme();
  const { setOverride: setDoubutsuOverride } = useDoubutsu();

  const availableTools = detected.filter((d) => d.available);
  const missingTools = detected.filter((d) => !d.available);

  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty } =
    useDirtyForm<SettingsFormState>(
      fromConfig(initialConfig, initialClientConfig),
    );

  // Drop any staged previews when leaving the settings page so the rest
  // of the app falls back to the saved values.
  useEffect(
    () => () => {
      setOverride(null);
      setDoubutsuOverride(null);
    },
    [setOverride, setDoubutsuOverride],
  );

  const handleSave = async () => {
    // Two stores behind one Save. useSettingsSave routes each field to
    // its engine and skips whichever store is unchanged.
    try {
      await save.mutateAsync(form);
      setSavedSnapshot(form);
    } catch (error) {
      // The mutation's toast and the banner below already surface the
      // failure. A partial failure still landed the device half, so
      // advance the snapshot for it: only the appearance fields stay
      // unsaved and Save retries just those.
      if (error instanceof SettingsSaveError && error.devicePersisted) {
        setSavedSnapshot((prev) => ({
          ...form,
          theme: prev.theme,
          doubutsu: prev.doubutsu,
        }));
      }
    }
    // No explicit setOverride(null) -- the providers clear the override
    // automatically once `saved` catches up to the staged value.
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
    setOverride(null);
    setDoubutsuOverride(null);
  };

  const pickTheme = (theme: Theme) => {
    setForm((prev) => ({ ...prev, theme }));
    setOverride(theme);
  };

  const setDoubutsu = (next: boolean) => {
    setForm((prev) => ({ ...prev, doubutsu: next }));
    setDoubutsuOverride(next);
  };

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
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-10">
          <VersionSection />

          <AppearanceSection
            theme={form.theme}
            onPick={pickTheme}
            doubutsu={form.doubutsu}
            onDoubutsuChange={setDoubutsu}
          />

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
              onCheckedChange={(v) =>
                setForm((prev) => ({ ...prev, portPool: v }))
              }
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

          <CliSection />

          <HostingSection />

          <RemoteDevicesSection />

          <DetectedToolsSection
            tools={availableTools}
            hidden={form.hiddenLaunchers}
            onToggle={toggleToolHidden}
          />

          {missingTools.length > 0 && (
            <section className="space-y-4">
              <div>
                <SectionHeading className="mb-1">
                  Supported tools
                </SectionHeading>
                <p className="text-xs text-muted-foreground">
                  Shigomori knows how to open worktrees in these too. Install
                  any of them and they'll show up under detected.
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
                None yet. Add one to surface a command in every project's
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

          <DataLocationSection />

          <DangerZone />

          {save.error && <ErrorBanner>{save.error.message}</ErrorBanner>}
        </div>
      </div>
      <EditorFooter
        isDirty={isDirty}
        isPending={save.isPending}
        isSuccess={save.isSuccess}
        onDiscard={handleDiscard}
        onSave={() => void handleSave()}
      />
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
