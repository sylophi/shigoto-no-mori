import { useState } from "react";
import { FolderOpen, Plus, Save } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { BranchCombobox } from "@/components/ui/branch-combobox";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useDefaultBranch } from "@/hooks/useDefaultBranch";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useShigotoConfig } from "@/hooks/useShigotoConfig";
import { useShigotoWrite } from "@/hooks/useShigotoWrite";
import { tildify } from "@/lib/projectPaths";
import { configureProjectRoute } from "@/router";
import type { LauncherCommand, ShigotoConfig } from "@shared/schemas";
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

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-3xl flex-col gap-7">
          <section className="space-y-3">
            <SectionHeading>Location</SectionHeading>
            <div className="font-mono text-sm select-text" title={projectPath}>
              {tildify(projectPath, home)}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.api.shell.showItemInFolder(projectPath)
              }
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
      <footer className="flex items-center gap-3 border-t border-border bg-card px-6 py-2.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {isDirty ? "Unsaved changes" : write.isSuccess ? "Saved." : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDiscard}
          disabled={!isDirty || write.isPending}
        >
          Discard
        </Button>
        <Button
          size="sm"
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
