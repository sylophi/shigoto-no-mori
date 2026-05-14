import { useState } from "react";
import {
  AlertTriangle,
  Copy as CopyIcon,
  FolderOpen,
  Link as LinkIcon,
  Plus,
  Save,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { MaterialIcon } from "@/components/ui/material-icon";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { useFsStat } from "@/hooks/useFsStat";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useShigotoConfig } from "@/hooks/useShigotoConfig";
import { useShigotoWrite } from "@/hooks/useShigotoWrite";
import { tildify } from "@/lib/projectPaths";
import { notifyError } from "@/lib/toast";
import { configureProjectRoute } from "@/router";
import type {
  CarryOverEntry,
  LauncherCommand,
  ShigotoConfig,
} from "@shared/schemas";
import { CarryOverPickerModal } from "./CarryOverPickerModal";
import { CustomLauncherInput } from "./CustomLauncherInput";

export function ConfigureProject() {
  const { projectId } = configureProjectRoute.useParams();
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { data: config, isLoading: configLoading } =
    useShigotoConfig(projectId);
  const { data: resolvedDefaultBranch, isLoading: branchLoading } =
    useDefaultBranch(projectId);

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Project not found.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">Configure</h1>
        </div>
      </header>
      {configLoading || branchLoading || !resolvedDefaultBranch ? (
        <ConfigureSkeleton />
      ) : (
        <ConfigureForm
          key={projectId}
          projectId={projectId}
          projectPath={project.path}
          initialConfig={config ?? null}
          resolvedDefaultBranch={resolvedDefaultBranch}
        />
      )}
    </div>
  );
}

function ConfigureSkeleton() {
  return (
    <div className="flex flex-col gap-8 px-6 py-6">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Separator />
      <div className="space-y-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

interface FormState {
  defaultBranch: string;
  setup: string;
  teardown: string;
  launchers: LauncherCommand[];
  carryOver: CarryOverEntry[];
}

function fromConfig(
  config: ShigotoConfig | null,
  resolvedDefaultBranch: string,
): FormState {
  return {
    defaultBranch: config?.defaultBranch ?? resolvedDefaultBranch,
    setup: config?.scripts?.setup ?? "",
    teardown: config?.scripts?.teardown ?? "",
    launchers: config?.launchers ?? [],
    carryOver: config?.carryOver ?? [],
  };
}

function toConfig(
  original: ShigotoConfig | null,
  state: FormState,
): ShigotoConfig {
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
  };
}

interface ConfigureFormProps {
  projectId: string;
  projectPath: string;
  initialConfig: ShigotoConfig | null;
  resolvedDefaultBranch: string;
}

function ConfigureForm({
  projectId,
  projectPath,
  initialConfig,
  resolvedDefaultBranch,
}: ConfigureFormProps) {
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const navigate = useNavigate();
  const write = useShigotoWrite();

  const initial = fromConfig(initialConfig, resolvedDefaultBranch);
  const [form, setForm] = useState<FormState>(initial);
  const [savedSnapshot, setSavedSnapshot] = useState<FormState>(initial);

  const isDirty = JSON.stringify(form) !== JSON.stringify(savedSnapshot);
  const canSave = isDirty && form.defaultBranch.trim().length > 0;

  const handleSave = async () => {
    const next = toConfig(initialConfig, form);
    await write.mutateAsync({ projectId, config: next });
    setSavedSnapshot(form);
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
  };

  const updateLauncher = (id: string, patch: Partial<LauncherCommand>) => {
    setForm((prev) => ({
      ...prev,
      launchers: prev.launchers.map((l) =>
        l.id === id ? { ...l, ...patch } : l,
      ),
    }));
  };

  const removeLauncher = (id: string) => {
    setForm((prev) => ({
      ...prev,
      launchers: prev.launchers.filter((l) => l.id !== id),
    }));
  };

  const addLauncher = () => {
    setForm((prev) => ({
      ...prev,
      launchers: [
        ...prev.launchers,
        { id: crypto.randomUUID(), label: "", command: "" },
      ],
    }));
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
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-3xl flex-col gap-5">
          <section className="space-y-3">
            <SectionHeading>Location</SectionHeading>
            <div className="font-mono text-sm select-text" title={projectPath}>
              {tildify(projectPath, home)}
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
              Reveal in Finder
            </Button>
          </section>

          <Separator />

          <section className="space-y-3">
            <div>
              <SectionHeading>Worktrees</SectionHeading>
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
                onChange={(v) => setForm({ ...form, defaultBranch: v })}
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

          <Separator />

          <CarryOverSection
            projectId={projectId}
            projectPath={projectPath}
            entries={form.carryOver}
            onAdd={addCarryOver}
            onChangeMode={updateCarryOverMode}
            onRemove={removeCarryOver}
          />

          <Separator />

          <section className="space-y-4">
            <div>
              <SectionHeading>Scripts</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Run inside each worktree directory with{" "}
                <span className="font-mono">$SHIGOMORI_*</span> env vars set.
              </p>
            </div>
            <ScriptField
              id="script-setup"
              label="Setup"
              placeholder="bun install"
              description="One-time per worktree."
              value={form.setup}
              onChange={(setup) => setForm({ ...form, setup })}
            />
            <ScriptField
              id="script-teardown"
              label="Teardown"
              placeholder="rm -rf node_modules"
              description="Cleanup hook, runs on demand."
              value={form.teardown}
              onChange={(teardown) => setForm({ ...form, teardown })}
            />
          </section>

          <Separator />

          <section className="space-y-3">
            <div>
              <SectionHeading>Custom tools</SectionHeading>
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

          {write.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {write.error.message}
            </div>
          )}
        </div>
      </div>
      <footer className="flex h-[38px] items-center gap-3 border-t border-border bg-card px-6">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {isDirty ? "Unsaved changes" : write.isSuccess ? "Saved." : ""}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleDiscard}
          disabled={!isDirty || write.isPending}
        >
          Discard
        </Button>
        <Button
          size="xs"
          onClick={() => void handleSave()}
          disabled={!canSave || write.isPending}
        >
          <Save />
          {write.isPending ? "Saving…" : "Save"}
        </Button>
      </footer>
    </>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

interface ScriptFieldProps {
  id: string;
  label: string;
  placeholder: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
}

function ScriptField({
  id,
  label,
  placeholder,
  description,
  value,
  onChange,
}: ScriptFieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={value.includes("\n") ? 4 : 2}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
    </div>
  );
}

interface CarryOverSectionProps {
  projectId: string;
  projectPath: string;
  entries: CarryOverEntry[];
  onAdd: (entry: CarryOverEntry) => void;
  onChangeMode: (path: string, mode: CarryOverEntry["mode"]) => void;
  onRemove: (path: string) => void;
}

function CarryOverSection({
  projectId,
  projectPath,
  entries,
  onAdd,
  onChangeMode,
  onRemove,
}: CarryOverSectionProps) {
  const [picking, setPicking] = useState(false);
  const selectedPaths = new Set(entries.map((e) => e.path));

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading>Carry over</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Files and folders from the main checkout to copy or symlink into every
          new worktree. Useful for things git ignores, like{" "}
          <span className="font-mono">.env</span>,{" "}
          <span className="font-mono">node_modules</span>, or editor state.
        </p>
      </div>

      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <CarryOverRow
              key={entry.path}
              entry={entry}
              projectPath={projectPath}
              onChangeMode={(mode) => onChangeMode(entry.path, mode)}
              onRemove={() => onRemove(entry.path)}
            />
          ))}
        </div>
      )}

      <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
        <Plus />
        Add file or folder
      </Button>

      {picking && (
        <CarryOverPickerModal
          projectId={projectId}
          projectPath={projectPath}
          selectedPaths={selectedPaths}
          onPick={(entry) => onAdd(entry)}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}

interface CarryOverRowProps {
  entry: CarryOverEntry;
  projectPath: string;
  onChangeMode: (mode: CarryOverEntry["mode"]) => void;
  onRemove: () => void;
}

function CarryOverRow({
  entry,
  projectPath,
  onChangeMode,
  onRemove,
}: CarryOverRowProps) {
  const { data: stat, isLoading } = useFsStat(`${projectPath}/${entry.path}`);
  const missing = !isLoading && stat?.exists === false;
  const basename = entry.path.split("/").pop() ?? entry.path;
  return (
    <div className="group flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <MaterialIcon
          kind={stat?.isDirectory ? "folder" : "file"}
          name={basename}
          className="size-4"
        />
        <span
          className={cn(
            "min-w-0 truncate font-mono text-xs",
            missing && "text-destructive",
          )}
          title={entry.path}
        >
          {entry.path}
        </span>
        {missing && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
            title="Source no longer exists in the main checkout. New worktrees will skip this entry."
          >
            <AlertTriangle className="size-3" />
            missing
          </span>
        )}
      </span>
      <ModePicker mode={entry.mode} onChange={onChangeMode} />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${entry.path}`}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function ModePicker({
  mode,
  onChange,
}: {
  mode: CarryOverEntry["mode"];
  onChange: (mode: CarryOverEntry["mode"]) => void;
}) {
  const options: {
    value: CarryOverEntry["mode"];
    label: string;
    Icon: typeof LinkIcon;
    hint: string;
  }[] = [
    {
      value: "symlink",
      label: "Symlink",
      Icon: LinkIcon,
      hint: "Edits stay in sync with the main checkout.",
    },
    {
      value: "copy",
      label: "Copy",
      Icon: CopyIcon,
      hint: "Independent snapshot at worktree creation.",
    },
  ];
  return (
    <div className="inline-flex shrink-0 rounded-md border border-input p-0.5">
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.hint}
            className={cn(
              "inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[11px] transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <opt.Icon className="size-3" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
