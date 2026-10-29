import { useEffect, type ReactNode } from "react";
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
import {
  fromConfig,
  patchOf,
  rebaseConfigureDraft,
  snapshotAfterSave,
  toConfig,
} from "@shigomori/ui/lib/configureDraft.ts";

interface ConfigureFormProps {
  projectId: string;
  projectPath: string;
  initialConfig: ShigomoriConfig | null;
  resolvedDefaultBranch: string;
  leading?: ReactNode;
}

export function ConfigureForm({
  projectId,
  projectPath,
  initialConfig,
  resolvedDefaultBranch,
  leading,
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

  useEffect(() => {
    reseed(
      fromConfig(initialConfig, resolvedDefaultBranch),
      rebaseConfigureDraft,
    );
  }, [initialConfig, resolvedDefaultBranch, reseed]);

  const handleSave = async () => {
    const next = toConfig(initialConfig, form);
    const saved = savedSnapshot;
    await write.mutateAsync({
      projectId,
      patch: patchOf(toConfig(initialConfig, saved), next),
    });
    setSavedSnapshot((prev) =>
      snapshotAfterSave(
        initialConfig,
        resolvedDefaultBranch,
        form,
        saved,
        prev,
      ),
    );
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
      leading={leading}
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
