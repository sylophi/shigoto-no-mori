import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { tildify } from "@/lib/projectPaths";
import { queryKeys } from "@/lib/queryKeys";
import { notifyError } from "@/lib/toast";
import type { CliStatus } from "@shared/ipc/modules/cli";

// Install/uninstall of the CLI symlink lives here, not in a launch
// prompt: the app runs its bundled binary directly and never needs the
// link, so this is purely "do you want the command in your shell".
// Hidden entirely when there's nothing to link (Windows, dev run
// without a built binary).
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
    onSuccess: applyStatus,
    onError: (err) => notifyError("Couldn't uninstall the CLI", err),
  });

  if (!status?.supported) return null;

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
    </section>
  );
}
