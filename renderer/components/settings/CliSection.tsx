import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { tildify } from "@/lib/projectPaths";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";
import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shared/ipc/modules/cli";

// Install/uninstall of the CLI symlink lives here, not in a launch
// prompt: the app runs its bundled binary directly and never needs the
// link, so this is purely "do you want the command in your shell".
export function CliSection() {
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const { data: status } = useQuery<CliStatus>({
    queryKey: queryKeys.cli(),
    queryFn: () => window.api.cli.status(),
    meta: { errorTitle: "Couldn't check the CLI install" },
  });

  const applyStatus = (next: CliStatus) => {
    queryClient.setQueryData(queryKeys.cli(), next);
  };
  const install = useMutation({
    mutationFn: (payload: { force: boolean }) =>
      window.api.cli.install(payload),
    onSuccess: applyStatus,
    onError: (err) => notifyError("Couldn't install the CLI", err),
  });
  const uninstall = useMutation({
    mutationFn: () => window.api.cli.uninstall(),
    onSuccess: (next) => {
      applyStatus(next);
      // CLI uninstall sweeps the shell hooks too.
      void queryClient.invalidateQueries({ queryKey: queryKeys.cliShell() });
    },
    onError: (err) => notifyError("Couldn't uninstall the CLI", err),
  });

  if (!status) return null;

  const { name, state, onPath } = status;
  const busy = install.isPending || uninstall.isPending;
  const home = runtime?.homedir ?? null;
  // Older stored statuses may predate foreignPaths; the worst link is
  // always a truthful fallback.
  const foreignPaths = status.foreignPaths?.length
    ? status.foreignPaths
    : [status.linkPath];
  const pathLine = `export PATH="${home && status.binDir.startsWith(home) ? `$HOME${status.binDir.slice(home.length)}` : status.binDir}:$PATH"`;

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Command line tool</SectionHeading>
        <p className="text-xs text-muted-foreground">
          The Shigoto no Mori CLI lets you (or a coding agent) create, list,
          merge, and remove this app's worktrees from any shell. Installing
          links the <span className="font-mono">{name}</span> and{" "}
          <span className="font-mono">{status.aliasName}</span> commands into{" "}
          <span className="font-mono">{tildify(status.binDir, home)}</span>.
        </p>
      </div>

      {state === "installed" && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Installed
          </span>
          <span className="font-mono text-sm text-muted-foreground select-text">
            {tildify(status.linkPath, home)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => uninstall.mutate()}
          >
            <Trash2 />
            Uninstall
          </Button>
        </div>
      )}

      {state === "stale" && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span className="size-1.5 rounded-full bg-amber-500" />
            Installed, but pointing at another copy of the app
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => install.mutate({ force: false })}
          >
            Repair link
          </Button>
        </div>
      )}

      {state === "missing" && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => install.mutate({ force: false })}
        >
          <Download />
          Install the CLI
        </Button>
      )}

      {state === "foreign" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {foreignPaths.map((path, i) => (
              <span key={path}>
                {i > 0 && " and "}
                <span className="font-mono">{tildify(path, home)}</span>
              </span>
            ))}{" "}
            {foreignPaths.length > 1
              ? "already exist and don't point at this app. Installing replaces both."
              : "already exists and doesn't point at this app. Installing replaces it."}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => install.mutate({ force: true })}
          >
            <Download />
            Replace and install
          </Button>
        </div>
      )}

      {state !== "missing" && state !== "foreign" && !onPath && (
        <p className="text-xs text-muted-foreground">
          <span className="text-amber-500">
            That directory isn't on your PATH yet.
          </span>{" "}
          Add this to your shell profile:{" "}
          <span className="font-mono select-text">{pathLine}</span>
        </p>
      )}

      {/* onPath gates it: the hook's `command -v` guard can never fire
          while the bin dir is off PATH, so offering Enable would
          install something inert and report it green. */}
      {state === "installed" && onPath && <ShellIntegrationBlock name={name} />}
    </section>
  );
}

// Shell integration, the optional second step after the link install:
// a hook in the user's shell config that makes cd/create move the
// calling shell instead of opening a nested subshell. All rc-file
// mechanics live in the CLI (`sm shell ...`), so the app only triggers
// them, so a terminal user and this section always agree.
function ShellIntegrationBlock({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const { data: runtime } = useRuntimeInfo();
  const home = runtime?.homedir ?? null;
  const { data: status } = useQuery<ShellIntegrationStatus>({
    queryKey: queryKeys.cliShell(),
    queryFn: () => window.api.cli.shellStatus(),
    meta: { errorTitle: "Couldn't check shell integration" },
  });

  const applyStatus = (next: ShellIntegrationStatus) => {
    queryClient.setQueryData(queryKeys.cliShell(), next);
  };
  const enable = useMutation({
    mutationFn: () => window.api.cli.shellInstall(),
    onSuccess: applyStatus,
    onError: (err) => notifyError("Couldn't enable shell integration", err),
  });
  const remove = useMutation({
    mutationFn: () => window.api.cli.shellUninstall(),
    onSuccess: applyStatus,
    onError: (err) => notifyError("Couldn't remove shell integration", err),
  });

  if (!status) return null;

  const busy = enable.isPending || remove.isPending;
  const login = status.shells.find((s) => s.shell === status.loginShell);
  const enabledAnywhere = status.shells.some((s) => s.state === "installed");

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        Shell integration makes <span className="font-mono">{name} cd</span> and{" "}
        <span className="font-mono">{name} new</span> move your shell into the
        worktree directly instead of opening a nested subshell. Enabling adds a
        removable block to your shell&apos;s config file.
      </p>

      {status.loginShell === null ? (
        <p className="text-xs text-muted-foreground">
          Your login shell isn&apos;t one integration supports (
          {status.shells.map((s) => s.shell).join(", ")}). Run{" "}
          <span className="font-mono select-text">{name} shell install</span>{" "}
          from the shell you use.
        </p>
      ) : login?.state === "installed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Enabled for {login.shell}
          </span>
          <span className="font-mono text-sm text-muted-foreground select-text">
            {tildify(login.path, home)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            <Trash2 />
            Remove
          </Button>
        </div>
      ) : login?.state === "modified" ? (
        <p className="text-xs text-muted-foreground">
          <span className="text-amber-500">
            The integration block in{" "}
            <span className="font-mono">{tildify(login.path, home)}</span> was
            edited,
          </span>{" "}
          so it won&apos;t be touched from here. Restore or remove it, then
          enable again.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => enable.mutate()}
          >
            <Download />
            Enable for {status.loginShell}
          </Button>
          {enabledAnywhere && (
            <span className="text-xs text-muted-foreground">
              Enabled for another shell. This adds your login shell.
            </span>
          )}
        </div>
      )}

      {(enable.isSuccess || remove.isSuccess) && (
        <p className="text-xs text-muted-foreground">
          Terminals already open keep the previous behavior until restarted.
        </p>
      )}
    </div>
  );
}
