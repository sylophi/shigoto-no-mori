import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  FolderOpen,
  Flame,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  SunMoon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EditorFooter } from "@/components/detail/EditorFooter";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useDirtyForm } from "@/hooks/ui/useDirtyForm";
import { useLauncherListEditor } from "@/hooks/launchers/useLauncherListEditor";
import { useDetectedLaunchers } from "@/hooks/launchers/useLaunchers";
import {
  useGlobalConfig,
  useGlobalConfigWrite,
} from "@/hooks/config/useGlobalConfig";
import { useGithubCliReadiness } from "@/hooks/system/useGithubCliReadiness";
import { usePortPoolInstalled } from "@/hooks/ports/usePortPoolInstalled";
import { cn } from "@/lib/utils";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { THEME_STORAGE_KEY, useTheme } from "@/hooks/ui/useTheme";
import { useUpdater } from "@/hooks/system/useUpdater";
import { useNavigate } from "@tanstack/react-router";
import { PathSpan } from "@/components/ui/path-span";
import { tildify } from "@/lib/projectPaths";
import { notifyError } from "@/lib/toast";
import type {
  GlobalConfig,
  LauncherCommand,
  Theme,
  UpdaterState,
} from "@shared/schemas";
import { LauncherIcon } from "@/lib/launcherIcon";
import { CustomLauncherInput } from "./CustomLauncherInput";

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
      <div className="space-y-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

interface FormState {
  theme: Theme;
  launchers: LauncherCommand[];
  deleteBranchOnRemove: boolean;
  autoPopulateInstall: boolean;
  portPool: boolean;
  githubCli: boolean;
}

function fromConfig(config: GlobalConfig): FormState {
  return {
    theme: config.theme ?? "system",
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

function SettingsForm({ initialConfig }: { initialConfig: GlobalConfig }) {
  const { data: runtime } = useRuntimeInfo();
  const { data: detected = [] } = useDetectedLaunchers();
  const { data: portPoolInstalled = true } = usePortPoolInstalled();
  const { data: githubCliReadiness } = useGithubCliReadiness();
  const ghInstalled = githubCliReadiness?.installed ?? true;
  const ghAuthed = githubCliReadiness?.authed ?? true;
  const ghReady = ghInstalled && ghAuthed;
  const write = useGlobalConfigWrite();
  const { setOverride } = useTheme();

  const availableTools = detected.filter((d) => d.available);
  const missingTools = detected.filter((d) => !d.available);

  const { form, setForm, savedSnapshot, setSavedSnapshot, isDirty } =
    useDirtyForm<FormState>(fromConfig(initialConfig));

  // Drop any staged theme preview when leaving the settings page so the
  // rest of the app falls back to the saved value.
  useEffect(() => () => setOverride(null), [setOverride]);

  const handleSave = async () => {
    await write.mutateAsync(toConfig(initialConfig, form));
    setSavedSnapshot(form);
    // No explicit setOverride(null) — the provider clears the override
    // automatically once `saved` catches up to the staged value.
  };

  const handleDiscard = () => {
    setForm(savedSnapshot);
    setOverride(null);
  };

  const pickTheme = (theme: Theme) => {
    setForm({ ...form, theme });
    setOverride(theme);
  };

  const { addLauncher, updateLauncher, removeLauncher } =
    useLauncherListEditor(setForm);

  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot ?? null;
  const configFilePath = root ? `${root}/config.json` : null;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
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

          <AppearanceSection theme={form.theme} onPick={pickTheme} />

          <section className="space-y-3">
            <SectionHeading className="mb-1">Worktrees</SectionHeading>
            <ToggleRow
              checked={form.deleteBranchOnRemove}
              onCheckedChange={(v) =>
                setForm({ ...form, deleteBranchOnRemove: v })
              }
              label="Delete branch when removing worktree"
              description="Force-deletes the local branch the worktree had checked out. Remote branches aren't touched. Skipped when the branch is still in use elsewhere or is the repo's primary HEAD."
            />
          </section>

          <section className="space-y-3">
            <SectionHeading className="mb-1">Integrations</SectionHeading>
            <ToggleRow
              checked={form.githubCli && ghReady}
              onCheckedChange={(v) => setForm({ ...form, githubCli: v })}
              disabled={!ghReady}
              label="Use GitHub CLI"
              description={ghDescription(ghInstalled, ghAuthed)}
            />
            <ToggleRow
              checked={form.autoPopulateInstall}
              onCheckedChange={(v) =>
                setForm({ ...form, autoPopulateInstall: v })
              }
              label="Auto-populate install command"
              description="When adding a project with a package.json, seed the setup script with the detected package manager's install command (e.g. pnpm install). Only runs at project-add time, so existing projects are untouched."
            />
            <ToggleRow
              checked={form.portPool && portPoolInstalled}
              onCheckedChange={(v) => setForm({ ...form, portPool: v })}
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
          )}

          <section className="space-y-3">
            <div>
              <SectionHeading className="mb-1">Custom tools</SectionHeading>
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

function AppearanceSection({
  theme,
  onPick,
}: {
  theme: Theme;
  onPick: (theme: Theme) => void;
}) {
  const options: { value: Theme; label: string; Icon: typeof Sun }[] = [
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
    { value: "system", label: "System", Icon: SunMoon },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Appearance</SectionHeading>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map(({ value, label, Icon }) => (
          <Button
            key={value}
            variant={theme === value ? "secondary" : "outline"}
            size="sm"
            onClick={() => onPick(value)}
          >
            <Icon />
            {label}
          </Button>
        ))}
      </div>
    </section>
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

function PortPoolLink({ children }: { children?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.api.shell
          .openExternal("https://github.com/sylophi/port-pool")
          .catch((err) => notifyError("Couldn't open port-pool", err));
      }}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children ?? "Learn more"}
    </button>
  );
}

function ToggleRow({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      <span className={cn("mt-0.5", disabled && "opacity-50")}>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
        />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className={cn("text-sm", disabled && "opacity-50")}>{label}</span>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </div>
    </label>
  );
}

function VersionSection() {
  const { state, check, install } = useUpdater();
  const kind = state?.kind ?? "idle";
  const ready = state?.kind === "ready" ? state : null;

  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Version</SectionHeading>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="font-mono text-sm select-text">
            {__APP_VERSION__}{" "}
            <span className="text-muted-foreground">({__APP_COMMIT__})</span>
          </div>
          {ready ? (
            <Button
              size="sm"
              onClick={() => install.mutate()}
              disabled={install.isPending}
            >
              <RefreshCw />
              Restart to update to v{ready.version}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => check.mutate()}
              disabled={kind === "checking" || kind === "downloading"}
            >
              {kind === "checking" || kind === "downloading" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {kind === "checking" ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
        <div className="-mt-1 block">
          <UpdaterStatusLine state={state} />
        </div>
      </div>
    </section>
  );
}

// The button already speaks for itself when an update is ready, so we
// only surface a status line for the states where the button alone is
// ambiguous: idle ("you already checked, nothing to do"), downloading
// ("we're working on it"), and error.
function UpdaterStatusLine({ state }: { state: UpdaterState | null }) {
  if (!state) return null;
  if (state.kind === "idle") {
    return (
      <span className="text-xs text-muted-foreground">You're up to date.</span>
    );
  }
  if (state.kind === "downloading") {
    return (
      <span className="text-xs text-muted-foreground">Downloading update…</span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="text-xs text-destructive" title={state.message}>
        Update check failed.
      </span>
    );
  }
  return null;
}

function DangerZone() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const [nuking, setNuking] = useState(false);

  const home = runtime?.homedir ?? null;
  const root = runtime?.shigomoriRoot
    ? tildify(runtime.shigomoriRoot, home)
    : "~/shigomori";

  const handleNuke = () => {
    trigger(async () => {
      setNuking(true);
      try {
        await window.api.runtime.nuke();
        try {
          window.localStorage.removeItem(THEME_STORAGE_KEY);
        } catch {
          // localStorage may be unavailable; not fatal.
        }
        await queryClient.invalidateQueries();
        void navigate({ to: "/" });
      } catch (err) {
        notifyError("Couldn't nuke shigomori data", err);
      } finally {
        setNuking(false);
      }
    });
  };

  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Danger zone</SectionHeading>
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
              ? "Click again to confirm. This cannot be undone."
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
      </div>
    </section>
  );
}
