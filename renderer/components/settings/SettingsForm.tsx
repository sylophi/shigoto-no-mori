import { useEffect } from "react";
import { ExternalLink, FolderOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditorFooter } from "@/components/shared/EditorFooter";
import { ErrorBanner } from "@/components/ui/error-banner";
import { LauncherIcon } from "@/components/LauncherIcon";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useDetectedLaunchers } from "@/hooks/launchers/useLaunchers";
import { useGlobalConfigWrite } from "@/hooks/config/useGlobalConfig";
import { useGithubCliReadiness } from "@/hooks/githubCli/useGithubCliReadiness";
import { useLauncherListEditor } from "@/hooks/launchers/useLauncherListEditor";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useTheme } from "@/hooks/ui/useTheme";
import { fileManagerName } from "@/components/ui/file-manager";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/toast";
import type {
  DetectedLauncher,
  GlobalConfig,
  LauncherCommand,
  Theme,
} from "@shared/schemas";
import { AppearanceSection } from "./AppearanceSection";
import { CustomLauncherInput } from "@/components/shared/CustomLauncherInput";
import { DangerZone } from "./DangerZone";
import { PortPoolLink } from "./PortPoolLink";
import { ToggleRow } from "./ToggleRow";
import { VersionSection } from "./VersionSection";

interface FormState {
  theme: Theme;
  doubutsu: boolean;
  launchers: LauncherCommand[];
  deleteBranchOnRemove: boolean;
  autoPopulateInstall: boolean;
  portPool: boolean;
  githubCli: boolean;
}

function fromConfig(config: GlobalConfig): FormState {
  return {
    theme: config.theme ?? "system",
    doubutsu: config.doubutsu ?? true,
    launchers: config.launchers ?? [],
    deleteBranchOnRemove: config.deleteBranchOnRemove ?? true,
    autoPopulateInstall: config.autoPopulateInstall ?? false,
    portPool: config.portPool ?? false,
    githubCli: config.githubCli ?? true,
  };
}

function toConfig(original: GlobalConfig, state: FormState): GlobalConfig {
  const valid = state.launchers.filter(
    (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
  );
  return {
    ...original,
    // Default is "system"; omit when on the default to keep config.json tidy.
    theme: state.theme === "system" ? undefined : state.theme,
    // Default is on; omit when on, store explicit `false` when off so
    // the user's opt-out survives reads (same as deleteBranchOnRemove).
    doubutsu: state.doubutsu ? undefined : false,
    launchers: valid.length > 0 ? valid : undefined,
    // Default is true; omit when on, store explicit `false` when off so
    // the user's opt-out survives reads.
    deleteBranchOnRemove: state.deleteBranchOnRemove ? undefined : false,
    // Default is false; only persist when explicitly enabled.
    autoPopulateInstall: state.autoPopulateInstall ? true : undefined,
    portPool: state.portPool ? true : undefined,
    // Default is true; same opt-out serialization as deleteBranchOnRemove.
    githubCli: state.githubCli ? undefined : false,
  };
}

export function SettingsForm({
  initialConfig,
}: {
  initialConfig: GlobalConfig;
}) {
  const { data: runtime } = useRuntimeInfo();
  const { data: detected = [] } = useDetectedLaunchers();
  const { data: portPoolInstalled = true } = usePortPoolInstalled();
  const { data: githubCliReadiness } = useGithubCliReadiness();
  const ghInstalled = githubCliReadiness?.installed ?? true;
  const ghAuthed = githubCliReadiness?.authed ?? true;
  const ghReady = ghInstalled && ghAuthed;
  const write = useGlobalConfigWrite();
  const { setOverride } = useTheme();
  const { setOverride: setDoubutsuOverride } = useDoubutsu();

  const availableTools = detected.filter((d) => d.available);
  const missingTools = detected.filter((d) => !d.available);

  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty } =
    useDirtyForm<FormState>(fromConfig(initialConfig));

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
    await write.mutateAsync(toConfig(initialConfig, form));
    setSavedSnapshot(form);
    // No explicit setOverride(null) — the providers clear the override
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

  const { addLauncher, updateLauncher, removeLauncher } =
    useLauncherListEditor(setForm);

  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot ?? null;
  const configFilePath = root ? `${root}/config.json` : null;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-10">
          <VersionSection />

          <section className="space-y-3">
            <SectionHeading className="mb-1">Location</SectionHeading>
            {root && (
              <div className="flex font-mono text-sm select-text">
                <PathSpan
                  path={configFilePath ?? root}
                  home={home}
                  className="min-w-0 flex-1 truncate"
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!root}
                onClick={() => {
                  if (root) {
                    window.api.shell
                      .showItemInFolder(root)
                      .catch((err) =>
                        notifyError("Couldn't reveal folder", err),
                      );
                  }
                }}
              >
                <FolderOpen />
                Reveal in {fileManagerName}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!configFilePath}
                onClick={() => {
                  if (configFilePath) {
                    window.api.shell
                      .openPath(configFilePath)
                      .catch((err) => notifyError("Couldn't open file", err));
                  }
                }}
                title={configFilePath ?? undefined}
              >
                <ExternalLink />
                Open config file
              </Button>
            </div>
          </section>

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
            {/* port-pool only ships for macOS; the row is absent (not
                disabled) on other platforms. */}
            {isMac && (
              <ToggleRow
                checked={form.portPool && portPoolInstalled}
                onCheckedChange={(v) =>
                  setForm((prev) => ({ ...prev, portPool: v }))
                }
                disabled={!portPoolInstalled}
                label="Automatically use port-pool"
                description={
                  <>
                    Allocates ports for new worktrees and releases them on
                    delete. Activates when a project has a{" "}
                    <span className="font-mono">port-pool.config.json</span>.{" "}
                    <PortPoolLink>
                      {portPoolInstalled
                        ? "Learn more"
                        : "Install port-pool to enable this integration."}
                    </PortPoolLink>
                  </>
                }
              />
            )}
          </section>

          <section className="space-y-4">
            <div>
              <SectionHeading className="mb-1">Detected tools</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Editors and tools found on this machine. Shown in every worktree
                automatically.
              </p>
            </div>
            {availableTools.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                Nothing detected yet. Install a supported tool below and
                Shigomori will pick it up on next launch.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {availableTools.map((d) => (
                  <ToolPill key={d.id} entry={d} />
                ))}
              </div>
            )}
          </section>

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
                  <ToolPill key={d.id} entry={d} missing />
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
                <span className="font-mono">
                  {isMac ? "open ." : "start ."}
                </span>
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

          <DangerZone />

          {write.error && <ErrorBanner>{write.error.message}</ErrorBanner>}
        </div>
      </div>
      <EditorFooter
        isDirty={isDirty}
        isPending={write.isPending}
        isSuccess={write.isSuccess}
        onDiscard={handleDiscard}
        onSave={() => void handleSave()}
      />
    </>
  );
}

function ToolPill({
  entry,
  missing = false,
}: {
  entry: DetectedLauncher;
  missing?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border py-0.5 pr-2 pl-1.5 text-xs",
        missing
          ? "border-dashed border-border text-muted-foreground/60"
          : "border-border bg-card text-muted-foreground",
      )}
      title={missing ? "Not installed" : undefined}
    >
      <LauncherIcon
        entry={entry}
        className={cn("size-3.5", missing && "opacity-60")}
      />
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
