import { useEffect } from "react";
import { FolderOpen, Plus } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { Button } from "@/components/ui/button";
import { EditorFooterView } from "@/components/shared/EditorFooterView";
import { ErrorBanner } from "@/components/ui/error-banner";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading, SectionIntro } from "@/components/ui/section-heading";
import { fieldSetter, useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { useLauncherListEditor } from "@/hooks/launchers/useLauncherListEditor";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useShigomoriWrite } from "@/hooks/config/useShigomoriWrite";
import { notifyError } from "@/lib/toast";
import {
  type CarryOverEntry,
  type LauncherCommand,
  PROJECT_CONFIG_DEFAULTS,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas";
import { ToggleRowView } from "@/components/shared/ToggleRowView";
import { CarryOverSection } from "./CarryOverSection";
import { CustomLauncherInputView } from "@/components/shared/CustomLauncherInputView";
import { ScriptEnvPopoverView } from "@/components/shared/ScriptEnvPopoverView";
import { ScriptField } from "./ScriptField";
import { WorktreeLocationField } from "./WorktreeLocationField";
import { selectSettingsTab } from "@/components/settings/settingsNav";
import { LAUNCH_TAB } from "@/components/settings/settingsSections";
import { PAGE_BODY } from "@/components/shared/PageShellView";

interface FormState {
  defaultBranch: string;
  setup: string;
  teardown: string;
  launchers: readonly LauncherCommand[];
  carryOver: readonly CarryOverEntry[];
  useWorktreeInclude: boolean;
  showPrimaryInInbox: boolean;
}

function fromConfig(
  config: ShigomoriConfig | null,
  resolvedDefaultBranch: string,
): FormState {
  return {
    defaultBranch: config?.defaultBranch ?? resolvedDefaultBranch,
    setup: config?.scripts?.setup ?? "",
    teardown: config?.scripts?.teardown ?? "",
    launchers: config?.launchers ?? PROJECT_CONFIG_DEFAULTS.launchers,
    carryOver: config?.carryOver ?? PROJECT_CONFIG_DEFAULTS.carryOver,
    useWorktreeInclude:
      config?.useWorktreeInclude ?? PROJECT_CONFIG_DEFAULTS.useWorktreeInclude,
    showPrimaryInInbox:
      config?.showPrimaryInInbox ?? PROJECT_CONFIG_DEFAULTS.showPrimaryInInbox,
  };
}

const unlessDefault = <T,>(value: T, fallback: T): T | undefined =>
  value === fallback ? undefined : value;

function toConfig(
  original: ShigomoriConfig | null,
  state: FormState,
): ShigomoriConfig {
  const scripts: { setup?: string; teardown?: string } = {};
  if (state.setup.trim()) scripts.setup = state.setup;
  if (state.teardown.trim()) scripts.teardown = state.teardown;

  const validLaunchers = state.launchers.filter(
    (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
  );

  return {
    ...original,
    defaultBranch: state.defaultBranch.trim(),
    scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
    launchers: validLaunchers.length > 0 ? validLaunchers : undefined,
    carryOver: state.carryOver.length > 0 ? state.carryOver : undefined,
    // Defaults are stored by omission.
    useWorktreeInclude: unlessDefault(
      state.useWorktreeInclude,
      PROJECT_CONFIG_DEFAULTS.useWorktreeInclude,
    ),
    showPrimaryInInbox: unlessDefault(
      state.showPrimaryInInbox,
      PROJECT_CONFIG_DEFAULTS.showPrimaryInInbox,
    ),
  };
}

interface ConfigureFormProps {
  projectId: string;
  projectPath: string;
  initialConfig: ShigomoriConfig | null;
  resolvedDefaultBranch: string;
}

export function ConfigureForm({
  projectId,
  projectPath,
  initialConfig,
  resolvedDefaultBranch,
}: ConfigureFormProps) {
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  // Which device's project file this form edits. `remote` gates what
  // only means something here (revealing the folder opens THIS
  // machine's file manager, the Settings link opens its launch tools),
  // and the label names the peer where the copy would otherwise mislead.
  const { deviceId, remote } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const navigate = useNavigate();
  const write = useShigomoriWrite();

  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty, reseed } =
    useDirtyForm<FormState>(fromConfig(initialConfig, resolvedDefaultBranch));
  const setField = fieldSetter(setForm);
  const canSave = isDirty && form.defaultBranch.trim().length > 0;

  // The config can change underneath an open draft: creating a worktree
  // auto-removes carry-over entries that .worktreeinclude now covers.
  // Rebase the snapshot and drop remotely-removed entries from the draft
  // so a later Save can't resurrect them.
  useEffect(() => {
    reseed(
      fromConfig(initialConfig, resolvedDefaultBranch),
      (prevForm, prevSnapshot, next) => {
        const nextPaths = new Set(next.carryOver.map((e) => e.path));
        const removedRemotely = new Set<string>();
        for (const entry of prevSnapshot.carryOver) {
          if (!nextPaths.has(entry.path)) removedRemotely.add(entry.path);
        }
        return {
          ...prevForm,
          carryOver: prevForm.carryOver.filter(
            (e) => !removedRemotely.has(e.path),
          ),
        };
      },
    );
  }, [initialConfig, resolvedDefaultBranch, reseed]);

  const handleSave = async () => {
    const next = toConfig(initialConfig, form);
    await write.mutateAsync({ projectId, config: next });
    // Snapshot what was actually persisted, not the raw form: toConfig
    // drops half-filled launcher rows and normalizes fields. Snapshotting
    // the raw form would mark those leftovers clean, and the post-save
    // refetch would reseed the form from disk and silently wipe them.
    setSavedSnapshot(fromConfig(next, resolvedDefaultBranch));
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
  };

  const { addLauncher, updateLauncher, removeLauncher } =
    useLauncherListEditor(setForm);

  const addCarryOver = (entry: CarryOverEntry) => {
    setForm((prev) =>
      prev.carryOver.some((c) => c.path === entry.path)
        ? prev
        : { ...prev, carryOver: [...prev.carryOver, entry] },
    );
  };

  const updateCarryOverMode = (path: string, mode: CarryOverEntry["mode"]) => {
    setForm((prev) => ({
      ...prev,
      carryOver: prev.carryOver.map((c) =>
        c.path === path ? { ...c, mode } : c,
      ),
    }));
  };

  const removeCarryOver = (path: string) => {
    setForm((prev) => ({
      ...prev,
      carryOver: prev.carryOver.filter((c) => c.path !== path),
    }));
  };

  return (
    <>
      <div className={PAGE_BODY}>
        <div className="flex flex-col gap-10">
          <section className="space-y-3">
            <SectionHeading className="mb-1">Location</SectionHeading>
            <div className="flex font-mono text-sm select-text">
              <PathSpan
                path={projectPath}
                home={home}
                className="min-w-0 flex-1 truncate"
              />
            </div>
            {!remote && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  window.api.shell
                    .showItemInFolder({ path: projectPath })
                    .catch((err) => notifyError("Couldn't reveal folder", err));
                }}
              >
                <FolderOpen />
                Reveal in Finder
              </Button>
            )}
          </section>

          <section className="space-y-4">
            <SectionIntro title="Worktrees">
              Settings for branches created inside this project.
            </SectionIntro>
            <div className="space-y-1.5">
              <label
                htmlFor="default-branch"
                className="block text-sm font-medium"
              >
                Default branch
              </label>
              <BranchCombobox
                id="default-branch"
                projectId={projectId}
                value={form.defaultBranch}
                onChange={setField("defaultBranch")}
                placeholder={resolvedDefaultBranch}
              />
              <p className="text-xs text-muted-foreground">
                Pre-fills "Branched from" when starting a new worktree. Falls
                back to <span className="font-mono">main</span> /{" "}
                <span className="font-mono">master</span> /{" "}
                <span className="font-mono">dev</span> (in that order, then the
                first local branch) when the branch you set here doesn't exist.
              </p>
            </div>
            <WorktreeLocationField
              projectId={projectId}
              projectPath={projectPath}
              config={initialConfig}
              home={home}
              blocked={isDirty}
            />
          </section>

          <section className="space-y-3">
            <SectionHeading className="mb-1">Primary checkout</SectionHeading>
            <ToggleRowView
              checked={form.showPrimaryInInbox}
              onCheckedChange={setField("showPrimaryInInbox")}
              label="Show in the inbox"
              description="Lists it alongside the worktrees. The project view always shows it."
            />
          </section>

          <CarryOverSection
            projectId={projectId}
            projectPath={projectPath}
            entries={form.carryOver}
            useWorktreeInclude={form.useWorktreeInclude}
            onToggleUseWorktreeInclude={setField("useWorktreeInclude")}
            onAdd={addCarryOver}
            onChangeMode={updateCarryOverMode}
            onRemove={removeCarryOver}
          />

          <section className="space-y-4">
            <SectionIntro title="Scripts" action={<ScriptEnvPopoverView />}>
              Run inside the worktree directory.
            </SectionIntro>
            <ScriptField
              id="script-setup"
              label="Setup"
              value={form.setup}
              onChange={setField("setup")}
            />
            <ScriptField
              id="script-teardown"
              label="Teardown"
              value={form.teardown}
              onChange={setField("teardown")}
            />
          </section>

          <section className="space-y-3">
            {/* The Settings link opens THIS machine's launch tools, which
                say nothing about a peer's. A remote project's tools run
                from the window on that device, so say that instead. */}
            <SectionIntro
              title="Custom tools"
              action={<ScriptEnvPopoverView />}
            >
              {remote ? (
                <>
                  Tools specific to this project, launched from {deviceLabel}
                  &apos;s own window.
                </>
              ) : (
                <>
                  Tools specific to this project. For tools you want available
                  in every project (editors, agents), use{" "}
                  <button
                    type="button"
                    onClick={() => {
                      selectSettingsTab(LAUNCH_TAB);
                      void navigate({ to: "/settings" });
                    }}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    Settings
                  </button>
                  .
                </>
              )}
            </SectionIntro>
            {form.launchers.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                None yet. Add one to run a project-specific command in the
                worktree (e.g. <span className="font-mono">bun storybook</span>,
                a custom devbox shell).
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
              Add project tool
            </Button>
          </section>

          {write.error && (
            <ErrorBanner
              message={write.error.message}
              title="Couldn't save project config"
            />
          )}
        </div>
      </div>
      <EditorFooterView
        isDirty={isDirty}
        canSave={canSave}
        isPending={write.isPending}
        isSuccess={write.isSuccess}
        onDiscard={handleDiscard}
        onSave={() => void handleSave()}
      />
    </>
  );
}
