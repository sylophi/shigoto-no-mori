import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { EditorFooterView } from "@shigomori/ui/views/shared/EditorFooterView.tsx";
import { fieldSetter, useDirtyForm } from "@shigomori/ui/hooks/useDirtyForm.ts";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useShigomoriPatch } from "@/hooks/config/useShigomoriPatch";
import { notifyError } from "@/lib/toast";
import {
  type CarryOverEntry,
  PROJECT_CONFIG_DEFAULTS,
  type ProjectSettingsPatch,
  type ShigomoriConfig,
} from "@shigomori/contracts/schemas";
import { CarryOverSection } from "./CarryOverSection";
import { WorktreeLocationField } from "./WorktreeLocationField";
import { selectSettingsTab } from "@/components/settings/settingsNav";
import { LAUNCH_TAB } from "@shigomori/ui/views/settings/settingsSections.ts";
import {
  type ConfigureFormState as FormState,
  ConfigureFormView,
} from "@shigomori/ui/views/configure/ConfigureFormView.tsx";
import { useApi } from "@/lib/runtime/pageApi";

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

// The settings this form edits that differ between two of its documents,
// each as `after` has it, or null for one it left out: what a save
// changes, and nothing it didn't touch.
function patchOf(
  before: ShigomoriConfig,
  after: ShigomoriConfig,
): ProjectSettingsPatch {
  const fields = {
    defaultBranch: [before.defaultBranch, after.defaultBranch],
    "scripts.setup": [before.scripts?.setup, after.scripts?.setup],
    "scripts.teardown": [before.scripts?.teardown, after.scripts?.teardown],
    launchers: [before.launchers, after.launchers],
    carryOver: [before.carryOver, after.carryOver],
    useWorktreeInclude: [before.useWorktreeInclude, after.useWorktreeInclude],
    showPrimaryInInbox: [before.showPrimaryInInbox, after.showPrimaryInInbox],
  } as const;
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, [was, now]]) => JSON.stringify(was) !== JSON.stringify(now))
      .map(([key, [, now]]) => [key, now ?? null]),
  ) as ProjectSettingsPatch;
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
  const api = useApi();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  // Which device's project file this form edits. `remote` gates what
  // only means something here (revealing the folder opens THIS
  // machine's file manager, the Settings link opens its launch tools),
  // and the label names the peer where the copy would otherwise mislead.
  const { deviceId, remote } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const navigate = useNavigate();
  const write = useShigomoriPatch();

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
    await write.mutateAsync({
      projectId,
      patch: patchOf(toConfig(initialConfig, savedSnapshot), next),
    });
    // Snapshot what was actually persisted, not the raw form: toConfig
    // drops half-filled launcher rows and normalizes fields. Snapshotting
    // the raw form would mark those leftovers clean, and the post-save
    // refetch would reseed the form from disk and silently wipe them.
    setSavedSnapshot(fromConfig(next, resolvedDefaultBranch));
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
  };

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
    <ConfigureFormView
      form={form}
      setForm={setForm}
      projectPath={projectPath}
      home={home}
      remote={remote}
      deviceLabel={deviceLabel}
      onReveal={() => {
        api
          .run(api.shell.showItemInFolder({ path: projectPath }))
          .catch((err) => notifyError("Couldn't reveal folder", err));
      }}
      onOpenLaunchTools={() => {
        selectSettingsTab(LAUNCH_TAB);
        void navigate({ to: "/settings" });
      }}
      branchPicker={
        <BranchCombobox
          id="default-branch"
          projectId={projectId}
          value={form.defaultBranch}
          onChange={setField("defaultBranch")}
          placeholder={resolvedDefaultBranch}
        />
      }
      location={
        <WorktreeLocationField
          projectId={projectId}
          projectPath={projectPath}
          config={initialConfig}
          home={home}
          blocked={isDirty}
        />
      }
      carryOver={
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
      }
      saveError={write.error?.message ?? null}
      footer={
        <EditorFooterView
          isDirty={isDirty}
          canSave={canSave}
          isPending={write.isPending}
          isSuccess={write.isSuccess}
          onDiscard={handleDiscard}
          onSave={() => void handleSave()}
        />
      }
    />
  );
}
