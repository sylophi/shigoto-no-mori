import type { ReactNode } from "react";
import {
  Loader2,
  type LucideIcon,
  RefreshCw,
  ScrollText,
  Sparkles,
} from "lucide-react";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { peerReadOnlyNote } from "@shigomori/ui/lib/commandAccessCopy.ts";
import { UpdaterStatusLineView } from "./UpdaterStatusLineView";

// This build's version and commit, the way every version line here
// spells it: the local General section on the desktop, the client
// line on a hostless shell.
export function BuildVersionLineView({
  version,
  commit,
}: {
  version: string;
  commit: string;
}) {
  return (
    <>
      {version} <span className="text-muted-foreground">({commit})</span>
    </>
  );
}

// The Version section of a device: the build it runs and the update
// action. One shape and one set of words on every device's General
// section. Only the updater it talks to differs, through the
// surrounding host scope (this window's own with no provider mounted,
// a peer's over its direct session inside one). Under the status line,
// the changelog, measured against the device's version, which previews
// a staged update.
export function VersionSectionView({
  version,
  canCommand,
  state,
  isError,
  onRetry,
  onCheck,
  onOpenChangelog,
  restart,
  changelog,
}: {
  // The mono version line: this build's version and commit for the
  // local device, the welcome-confirmed version for a peer.
  version: ReactNode;
  // Checking and installing are commands, so on a peer both wait for
  // its grant.
  canCommand: boolean;
  // The updater's state, null before the first read lands.
  state: UpdaterState | null;
  isError: boolean;
  onRetry: () => void;
  onCheck: () => void;
  // Opens what the staged update brings, or all of it.
  onOpenChangelog: (which: "news" | "all") => void;
  // The restart into a staged update (RestartToUpdateButton).
  restart: ReactNode;
  // The changelog, while it is open.
  changelog: ReactNode;
}) {
  const kind = state?.kind ?? "idle";
  const ready = state?.kind === "ready" ? state : null;
  const busy = kind === "checking" || kind === "downloading";
  const blockedTip = canCommand ? undefined : peerReadOnlyNote("this device");
  // No state to show: the first read failed. Over a wire that is
  // still dialing, or on a peer build without the channel, the error
  // looks the same, so say only what is known and offer a retry.
  const unavailable = state === null && isError;

  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Version</SectionHeading>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="font-mono text-sm select-text">{version}</div>
          {/* The changelog doors, then the update action. */}
          <div className="flex flex-wrap items-center gap-2">
            {ready && (
              <ChangelogButtonView
                icon={Sparkles}
                label="See what's new"
                onOpen={() => onOpenChangelog("news")}
              />
            )}
            <ChangelogButtonView
              icon={ScrollText}
              label="Changelog"
              onOpen={() => onOpenChangelog("all")}
            />
            {kind === "unsupported" ? null : unavailable ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw />
                Try again
              </Button>
            ) : ready ? (
              restart
            ) : (
              <SimpleTooltip tip={blockedTip}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !canCommand}
                  onClick={onCheck}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {kind === "checking" ? "Checking…" : "Check for updates"}
                </Button>
              </SimpleTooltip>
            )}
          </div>
        </div>
        <div className="-mt-1 flex flex-wrap items-baseline gap-x-2 text-xs">
          {unavailable ? (
            <span className="text-muted-foreground">
              Couldn&apos;t read the update status.
            </span>
          ) : (
            <UpdaterStatusLineView state={state} />
          )}
        </div>
      </div>
      {changelog}
    </section>
  );
}

// A door into the changelog, beside the update action: the whole
// changelog, or what a staged update brings. Quiet, so the update
// action stays the loud one.
export function ChangelogButtonView({
  icon: Icon,
  label,
  onOpen,
}: {
  icon: LucideIcon;
  label: string;
  onOpen: () => void;
}) {
  return (
    <Button variant="ghost" size="sm" onClick={onOpen}>
      <Icon />
      {label}
    </Button>
  );
}

// Restarts the scoped device into its staged update, from its Version
// section or the preview of that update. A remote restart is the one
// action here that ends a session someone else may be using, so it
// asks for a second click where the local one has the busy dialog.
export function RestartToUpdateButtonView({
  version,
  remote,
  canCommand,
  armed,
  pending,
  onClick,
}: {
  version: string;
  remote: boolean;
  canCommand: boolean;
  // A remote restart asked for once.
  armed: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <SimpleTooltip
      tip={canCommand ? undefined : peerReadOnlyNote("this device")}
    >
      <Button
        size="sm"
        disabled={pending || !canCommand}
        aria-pressed={remote ? armed : undefined}
        onClick={onClick}
      >
        <RefreshCw />
        {armed ? "Click again to confirm" : `Restart to update to v${version}`}
      </Button>
    </SimpleTooltip>
  );
}
