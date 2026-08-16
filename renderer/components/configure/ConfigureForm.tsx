import { useEffect } from "react";
import { FolderOpen, Plus } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { EditorFooter } from "@/components/shared/EditorFooter";
import { ErrorBanner } from "@/components/ui/error-banner";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { useLauncherListEditor } from "@/hooks/launchers/useLauncherListEditor";
import { useLaunchSetEditor } from "@/hooks/launchers/useLaunchSetEditor";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useShigomoriWrite } from "@/hooks/config/useShigomoriWrite";
import { fileManagerName } from "@/lib/platform";
import { notifyError } from "@/lib/toast";
import type {
  CarryOverEntry,
  LauncherCommand,
  LaunchSet,
  ShigomoriConfig,
} from "@shared/schemas";
import { SCRIPT_ENV_DOCS } from "@shared/scriptEnv";
import { CarryOverSection } from "./CarryOverSection";
import { CustomLauncherInput } from "@/components/shared/CustomLauncherInput";
import { LaunchSetsSection } from "./LaunchSetsSection";
import { ScriptField } from "./ScriptField";

interface FormState {
  defaultBranch: string;
  setup: string;
  teardown: string;
  launchers: LauncherCommand[];
  launchSets: LaunchSet[];
  autoLaunchSetId: string | null;
  carryOver: CarryOverEntry[];
  useWorktreeInclude: boolean;
}

function fromConfig(
  config: ShigomoriConfig | null,
  resolvedDefaultBranch: string,
): FormState {
  return {
    defaultBranch: config?.defaultBranch ?? resolvedDefaultBranch,
    setup: config?.scripts?.setup ?? "",
    teardown: config?.scripts?.teardown ?? "",
    launchers: config?.launchers ?? [],
    launchSets: config?.launchSets ?? [],
    autoLaunchSetId: config?.autoLaunchSetId ?? null,
    carryOver: config?.carryOver ?? [],
    useWorktreeInclude: config?.useWorktreeInclude !== false,
  };
}

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

  // A set needs a name and at least one tool to mean anything; half-built
  // ones are dropped the same way half-filled launcher rows are. The
  // auto-launch pick follows -- pointing it at a set that didn't survive
  // would silently do nothing on the next create.
  const validSets = state.launchSets
    .filter((s) => s.label.trim().length > 0 && s.launcherIds.length > 0)
    .map((s) => ({
      id: s.id,
      label: s.label.trim(),
      launcherIds: s.launcherIds,
    }));
  const autoLaunchSetId = validSets.some((s) => s.id === state.autoLaunchSetId)
    ? (state.autoLaunchSetId ?? undefined)
    : undefined;

  return {
    ...original,
    defaultBranch: state.defaultBranch.trim(),
    scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
    launchers: validLaunchers.length > 0 ? validLaunchers : undefined,
    launchSets: validSets.length > 0 ? validSets : undefined,
    autoLaunchSetId,
    carryOver: state.carryOver.length > 0 ? state.carryOver : undefined,
    // Enabled is the default; only persist the opt-out.
    useWorktreeInclude: state.useWorktreeInclude ? undefined : false,
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
  const navigate = useNavigate();
  const write = useShigomoriWrite();

  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty, reseed } =
    useDirtyForm<FormState>(fromConfig(initialConfig, resolvedDefaultBranch));
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

  const {
    addSet,
    renameSet,
    removeSet,
    addMember,
    removeMember,
    moveMember,
    setAutoLaunch,
  } = useLaunchSetEditor(setForm);

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
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="flex max-w-3xl flex-col gap-10">
          <section className="space-y-3">
            <SectionHeading className="mb-1">Location</SectionHeading>
            <div className="flex font-mono text-sm select-text">
              <PathSpan
                path={projectPath}
                home={home}
                className="min-w-0 flex-1 truncate"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                window.api.shell
                  .showItemInFolder(projectPath)
                  .catch((err) => notifyError("Couldn't reveal folder", err));
              }}
            >
              <FolderOpen />
              Reveal in {fileManagerName}
            </Button>
          </section>

          <section className="space-y-3">
            <div>
              <SectionHeading className="mb-1">Worktrees</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Settings for branches created inside this project.
              </p>
            </div>
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
                onChange={(v) =>
                  setForm((prev) => ({ ...prev, defaultBranch: v }))
                }
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
          </section>

          <CarryOverSection
            projectId={projectId}
            projectPath={projectPath}
            entries={form.carryOver}
            useWorktreeInclude={form.useWorktreeInclude}
            onToggleUseWorktreeInclude={(useWorktreeInclude) =>
              setForm((prev) => ({ ...prev, useWorktreeInclude }))
            }
            onAdd={addCarryOver}
            onChangeMode={updateCarryOverMode}
            onRemove={removeCarryOver}
          />

          <section className="space-y-4">
            <div>
              <SectionHeading className="mb-1">Scripts</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Run inside the worktree directory. These env vars are available:
              </p>
              <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground select-text">
                {SCRIPT_ENV_DOCS.map((row) => (
                  <li key={row.name}>
                    <span className="font-mono text-foreground/80">
                      {row.name}
                    </span>
                    : {row.desc}
                  </li>
                ))}
              </ul>
            </div>
            <ScriptField
              id="script-setup"
              label="Setup"
              value={form.setup}
              onChange={(setup) => setForm((prev) => ({ ...prev, setup }))}
            />
            <ScriptField
              id="script-teardown"
              label="Teardown"
              value={form.teardown}
              onChange={(teardown) =>
                setForm((prev) => ({ ...prev, teardown }))
              }
            />
          </section>

          <section className="space-y-3">
            <div>
              <SectionHeading className="mb-1">Custom tools</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Tools specific to this project. For tools you want available in
                every project (editors, agents), use{" "}
                <button
                  type="button"
                  onClick={() => navigate({ to: "/settings" })}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Settings
                </button>
                .
              </p>
            </div>
            {form.launchers.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                None yet. Add one to run a project-specific command in the
                worktree (e.g. <span className="font-mono">bun storybook</span>,
                a custom devbox shell).
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
              Add project tool
            </Button>
          </section>

          <LaunchSetsSection
            projectId={projectId}
            sets={form.launchSets}
            autoLaunchSetId={form.autoLaunchSetId}
            onAdd={addSet}
            onRename={renameSet}
            onRemove={removeSet}
            onAddMember={addMember}
            onRemoveMember={removeMember}
            onMoveMember={moveMember}
            onToggleAutoLaunch={setAutoLaunch}
          />

          {write.error && <ErrorBanner>{write.error.message}</ErrorBanner>}
        </div>
      </div>
      <EditorFooter
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
