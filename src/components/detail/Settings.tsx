import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  FolderOpen,
  Flame,
  Moon,
  Plus,
  Save,
  Sun,
  SunMoon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useConfirmTwice } from "@/hooks/useConfirmTwice";
import { useDetectedLaunchers } from "@/hooks/useLaunchers";
import { useGlobalConfig, useGlobalConfigWrite } from "@/hooks/useGlobalConfig";
import { useRuntimeInfo } from "@/hooks/useRuntimeInfo";
import { useTheme } from "@/hooks/useTheme";
import { useNavigate } from "@tanstack/react-router";
import { tildify } from "@/lib/projectPaths";
import { notifyError } from "@/lib/toast";
import type { GlobalConfig, LauncherCommand } from "@shared/schemas";
import { LauncherIcon } from "@/lib/launcherIcon";
import { CustomLauncherInput } from "./CustomLauncherInput";

const THEME_STORAGE_KEY = "shigomori.theme";

export function Settings() {
  const { data: config, isLoading } = useGlobalConfig();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 pt-7 pb-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">Shigoto no Mori</span>
          <h1 className="text-lg font-medium tracking-tight">Settings</h1>
        </div>
      </header>
      {isLoading ? (
        <SettingsSkeleton />
      ) : (
        <SettingsForm initialConfig={config ?? {}} />
      )}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-8 px-6 py-6">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Separator />
      <div className="space-y-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

interface FormState {
  launchers: LauncherCommand[];
  deleteBranchOnRemove: boolean;
}

function fromConfig(config: GlobalConfig): FormState {
  return {
    launchers: config.launchers ?? [],
    deleteBranchOnRemove: config.deleteBranchOnRemove ?? true,
  };
}

function toConfig(original: GlobalConfig, state: FormState): GlobalConfig {
  const valid = state.launchers.filter(
    (l) => l.label.trim().length > 0 && l.command.trim().length > 0,
  );
  return {
    ...original,
    launchers: valid.length > 0 ? valid : undefined,
    // Default is true; omit when on, store explicit `false` when off so
    // the user's opt-out survives reads.
    deleteBranchOnRemove: state.deleteBranchOnRemove ? undefined : false,
  };
}

function SettingsForm({ initialConfig }: { initialConfig: GlobalConfig }) {
  const { data: runtime } = useRuntimeInfo();
  const { data: detected = [] } = useDetectedLaunchers();
  const write = useGlobalConfigWrite();

  const availableTools = detected.filter((d) => d.available);
  const missingTools = detected.filter((d) => !d.available);

  const initial = fromConfig(initialConfig);
  const [form, setForm] = useState<FormState>(initial);
  const [savedSnapshot, setSavedSnapshot] = useState<FormState>(initial);

  const isDirty = JSON.stringify(form) !== JSON.stringify(savedSnapshot);

  const handleSave = async () => {
    await write.mutateAsync(toConfig(initialConfig, form));
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

  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot ?? null;
  const configFilePath = root ? `${root}/config.json` : null;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="flex max-w-3xl flex-col gap-5">
          <section className="space-y-3">
            <SectionHeading>Location</SectionHeading>
            {root && (
              <div
                className="font-mono text-sm select-text"
                title={configFilePath ?? root}
              >
                {tildify(configFilePath ?? root, home)}
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
                Reveal in Finder
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

          <Separator />

          <AppearanceSection />

          <Separator />

          <section className="space-y-3">
            <SectionHeading>Worktrees</SectionHeading>
            <ToggleRow
              checked={form.deleteBranchOnRemove}
              onCheckedChange={(v) =>
                setForm({ ...form, deleteBranchOnRemove: v })
              }
              label="Delete branch when removing worktree"
              description="Force-deletes the local branch the worktree had checked out. Remote branches aren't touched. Skipped when the branch is still in use elsewhere or is the repo's primary HEAD."
            />
          </section>

          <Separator />

          <section className="space-y-4">
            <div>
              <SectionHeading>Detected tools</SectionHeading>
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
                  <span
                    key={d.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card py-0.5 pr-2 pl-1.5 text-xs text-muted-foreground"
                  >
                    <LauncherIcon entry={d} className="size-3.5" />
                    {d.label}
                  </span>
                ))}
              </div>
            )}
          </section>

          {missingTools.length > 0 && (
            <>
              <Separator />
              <section className="space-y-4">
                <div>
                  <SectionHeading>Supported tools</SectionHeading>
                  <p className="text-xs text-muted-foreground">
                    Shigomori knows how to open worktrees in these too. Install
                    any of them and they'll show up under detected.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {missingTools.map((d) => (
                    <span
                      key={d.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border py-0.5 pr-2 pl-1.5 text-xs text-muted-foreground/60"
                      title="Not installed"
                    >
                      <LauncherIcon entry={d} className="size-3.5 opacity-60" />
                      {d.label}
                    </span>
                  ))}
                </div>
              </section>
            </>
          )}

          <Separator />

          <section className="space-y-3">
            <div>
              <SectionHeading>Custom tools</SectionHeading>
              <p className="text-xs text-muted-foreground">
                Custom commands available in every worktree (e.g.{" "}
                <span className="font-mono">claude</span>,{" "}
                <span className="font-mono">tmux new-session</span>,{" "}
                <span className="font-mono">open .</span>).
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

          <Separator />

          <DangerZone />

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
          disabled={!isDirty || write.isPending}
        >
          <Save />
          {write.isPending ? "Saving…" : "Save"}
        </Button>
      </footer>
    </>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const options: { value: typeof theme; label: string; Icon: typeof Sun }[] = [
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
    { value: "system", label: "System", Icon: SunMoon },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading>Appearance</SectionHeading>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map(({ value, label, Icon }) => (
          <Button
            key={value}
            variant={theme === value ? "secondary" : "outline"}
            size="sm"
            onClick={() => setTheme(value)}
          >
            <Icon />
            {label}
          </Button>
        ))}
      </div>
    </section>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function ToggleRow({
  checked,
  onCheckedChange,
  label,
  description,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <span className="mt-0.5">
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">{label}</span>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </div>
    </label>
  );
}

function DangerZone() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const { armed, trigger } = useConfirmTwice(5_000);
  const [nuking, setNuking] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot
    ? tildify(runtime.shigomoriRoot, home)
    : "~/shigomori";

  const handleNuke = () => {
    trigger(async () => {
      setNuking(true);
      setError(null);
      try {
        await window.api.runtime.nuke();
        try {
          window.localStorage.removeItem(THEME_STORAGE_KEY);
        } catch {
          // localStorage may be unavailable; not fatal.
        }
        await queryClient.invalidateQueries();
        void navigate({ to: "/" });
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setNuking(false);
      }
    });
  };

  return (
    <section className="space-y-3">
      <SectionHeading>Danger zone</SectionHeading>
      <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-destructive">
            Nuke everything
          </div>
          <p className="text-xs text-muted-foreground">
            Force-removes every worktree shigomori created, drops the project
            registry, and deletes all configs and state under{" "}
            <span className="font-mono">{root}</span>. The original project
            repos on disk are not touched.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={nuking}
          onClick={handleNuke}
          title={
            armed
              ? "Click again to confirm — this cannot be undone"
              : "Wipe all shigomori data"
          }
        >
          <Flame />
          {nuking
            ? "Nuking…"
            : armed
              ? "Click again to confirm"
              : "Nuke everything"}
        </Button>
        {error && (
          <div className="text-xs text-destructive">{error.message}</div>
        )}
      </div>
    </section>
  );
}
