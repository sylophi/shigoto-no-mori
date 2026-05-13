import { useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  Plus,
  Save,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useLauncherForProject } from "@/hooks/useLaunchers";
import { useProjects } from "@/hooks/useProjects";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useSelection } from "@/hooks/useSelection";
import { useShigotoConfig } from "@/hooks/useShigotoConfig";
import { useShigotoWrite } from "@/hooks/useShigotoWrite";
import { tildify } from "@/lib/projectPaths";
import type { LauncherCommand, ShigotoConfig } from "@shared/schemas";

interface ConfigureProjectProps {
  projectId: string;
}

export function ConfigureProject({ projectId }: ConfigureProjectProps) {
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { data: config, isLoading } = useShigotoConfig(projectId);
  const { clear } = useSelection();

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Project not found.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-8 py-4">
        <button
          type="button"
          onClick={clear}
          aria-label="Back"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">
            {project.name}
          </span>
          <h1 className="text-lg font-medium tracking-tight">Configure</h1>
        </div>
      </header>
      {isLoading ? (
        <ConfigureSkeleton />
      ) : (
        <ConfigureForm
          key={projectId}
          projectId={projectId}
          projectPath={project.path}
          initialConfig={config ?? null}
        />
      )}
    </div>
  );
}

function ConfigureSkeleton() {
  return (
    <div className="flex flex-col gap-8 px-8 py-6">
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
  setup: string;
  run: string;
  teardown: string;
  launchers: LauncherCommand[];
}

function fromConfig(config: ShigotoConfig | null): FormState {
  return {
    setup: config?.scripts?.setup ?? "",
    run: config?.scripts?.run ?? "",
    teardown: config?.scripts?.teardown ?? "",
    launchers: config?.launchers ?? [],
  };
}

function toConfig(
  original: ShigotoConfig | null,
  state: FormState,
): ShigotoConfig {
  const scripts: { setup?: string; run?: string; teardown?: string } = {};
  if (state.setup.trim()) scripts.setup = state.setup;
  if (state.run.trim()) scripts.run = state.run;
  if (state.teardown.trim()) scripts.teardown = state.teardown;

  const validLaunchers = state.launchers.filter(
    (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
  );

  return {
    ...original,
    scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
    launchers: validLaunchers.length > 0 ? validLaunchers : undefined,
  };
}

interface ConfigureFormProps {
  projectId: string;
  projectPath: string;
  initialConfig: ShigotoConfig | null;
}

function ConfigureForm({
  projectId,
  projectPath,
  initialConfig,
}: ConfigureFormProps) {
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const { data: launcherData } = useLauncherForProject(projectId);
  const write = useShigotoWrite();

  const initial = fromConfig(initialConfig);
  const [form, setForm] = useState<FormState>(initial);
  const [savedSnapshot, setSavedSnapshot] = useState<FormState>(initial);

  const isDirty = JSON.stringify(form) !== JSON.stringify(savedSnapshot);
  const detected = (launcherData?.entries ?? []).filter(
    (e) => e.kind === "detected",
  );

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

  const configFilePath = `${projectPath}/shigomori.config.json`;

  return (
    <>
      <div className="overflow-y-auto px-8 py-6">
        <div className="flex max-w-3xl flex-col gap-7">
          <section className="space-y-3">
            <SectionHeading>Location</SectionHeading>
            <div className="font-mono text-sm select-text" title={projectPath}>
              {tildify(projectPath, home)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => void window.api.shell.openPath(configFilePath)}
                title={configFilePath}
              >
                <ExternalLink />
                Open config file
              </Button>
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
              id="script-run"
              label="Run"
              placeholder="bun dev"
              description="Long-running, output streams to the console."
              value={form.run}
              onChange={(run) => setForm({ ...form, run })}
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

          <section className="space-y-5">
            <div>
              <SectionHeading>Launchers</SectionHeading>
              <p className="text-xs text-muted-foreground">
                One-click commands to open this worktree in an editor or run an
                ad-hoc tool.
              </p>
            </div>

            {detected.length > 0 && (
              <div className="space-y-2">
                <SubHeading>Detected on this machine</SubHeading>
                <div className="flex flex-wrap items-center gap-1.5">
                  {detected.map((d) => (
                    <span
                      key={d.id}
                      className="inline-flex items-center rounded-md border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {d.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <SubHeading>Custom</SubHeading>
              {form.launchers.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">
                  Add a custom launcher to run anything in the worktree (e.g.{" "}
                  <span className="font-mono">claude</span>,{" "}
                  <span className="font-mono">tmux new-session</span>,{" "}
                  <span className="font-mono">open .</span>).
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
                Add custom launcher
              </Button>
            </div>
          </section>

          {write.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {write.error.message}
            </div>
          )}
        </div>
      </div>
      <footer className="flex items-center gap-3 border-t border-border bg-card px-8 py-2.5">
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
          disabled={!isDirty || write.isPending}
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

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-medium text-muted-foreground">{children}</div>
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

interface CustomLauncherInputProps {
  launcher: LauncherCommand;
  onChange: (patch: Partial<LauncherCommand>) => void;
  onRemove: () => void;
}

function CustomLauncherInput({
  launcher,
  onChange,
  onRemove,
}: CustomLauncherInputProps) {
  return (
    <div className="grid grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)_auto] items-center gap-2">
      <input
        type="text"
        value={launcher.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Label"
        aria-label="Launcher label"
        className="min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
      <input
        type="text"
        value={launcher.command}
        onChange={(e) => onChange({ command: e.target.value })}
        placeholder="Command"
        aria-label="Launcher command"
        className="min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove launcher"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
