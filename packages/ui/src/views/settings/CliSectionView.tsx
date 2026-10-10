import type { ReactNode } from "react";
import { Download, Trash2 } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import {
  SectionHeading,
  SectionIntro,
} from "../../primitives/section-heading.tsx";
import { tildify } from "@shigomori/contracts/projectPaths";
import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shigomori/contracts/modules/cli";

// Install/uninstall of the CLI symlink lives here, not in a launch
// prompt: the app runs its bundled binary directly and never needs the
// link, so this is purely "do you want the command in your shell".
//
// Host-scoped: the links and rc files belong to whichever device the
// section is mounted for, so a peer's section installs on the peer. A
// peer refuses the status read without the command grant, and the
// section then renders nothing rather than toasting a permission state.
export function CliSectionView({
  status,
  home,
  busy,
  onInstall,
  onUninstall,
  shell,
}: {
  status: CliStatus;
  // The device's home, for the paths.
  home: string | null;
  busy: boolean;
  // Installs the link, replacing what is there when `force`.
  onInstall: (force: boolean) => void;
  onUninstall: () => void;
  // Shell integration (ShellIntegrationBlock), offered once the link
  // is installed and on PATH.
  shell: ReactNode;
}) {
  const { name, state, onPath } = status;
  // Older stored statuses may predate foreignPaths; the worst link is
  // always a truthful fallback.
  const foreignPaths = status.foreignPaths?.length
    ? status.foreignPaths
    : [status.linkPath];
  const pathLine = `export PATH="${home && status.binDir.startsWith(home) ? `$HOME${status.binDir.slice(home.length)}` : status.binDir}:$PATH"`;

  return (
    <section className="space-y-3">
      <SectionIntro title="Command line tool">
        The Shigoto no Mori CLI lets you (or a coding agent) create, list,
        merge, and remove this app's worktrees from any shell. Installing links
        the <span className="font-mono">{name}</span> and{" "}
        <span className="font-mono">{status.aliasName}</span> commands into{" "}
        <span className="font-mono">{tildify(status.binDir, home)}</span>.
      </SectionIntro>

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
            onClick={onUninstall}
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
            onClick={() => onInstall(false)}
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
          onClick={() => onInstall(false)}
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
            onClick={() => onInstall(true)}
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
      {state === "installed" && onPath && shell}
    </section>
  );
}

// A peer's read that failed, said here since the toast layer stays
// silent for a peer (gatedHostReadMeta).
export function PeerReadErrorView({
  what,
  message,
  heading = false,
}: {
  what: string;
  message: string;
  heading?: boolean;
}) {
  const note = (
    <p className="text-xs text-muted-foreground select-text">
      Couldn&apos;t check {what} on that device: {message}
    </p>
  );
  if (!heading) return note;
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Command line tool</SectionHeading>
      {note}
    </section>
  );
}

// Shell integration, the optional second step after the link install:
// a hook in the user's shell config that makes cd/create move the
// calling shell instead of opening a nested subshell. All rc-file
// mechanics live in the CLI (`sm shell ...`), so the app only triggers
// them, so a terminal user and this section always agree.
export function ShellIntegrationView({
  name,
  status,
  home,
  busy,
  onEnable,
  onRemove,
  changed,
}: {
  name: string;
  status: ShellIntegrationStatus;
  home: string | null;
  busy: boolean;
  onEnable: () => void;
  onRemove: () => void;
  // Enabled or removed from here: open terminals keep the old behavior.
  changed: boolean;
}) {
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
            onClick={onRemove}
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
            onClick={onEnable}
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

      {changed && (
        <p className="text-xs text-muted-foreground">
          Terminals already open keep the previous behavior until restarted.
        </p>
      )}
    </div>
  );
}
