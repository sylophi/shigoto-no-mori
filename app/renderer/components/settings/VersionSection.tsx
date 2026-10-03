import { type ReactNode, useState } from "react";
import {
  Loader2,
  type LucideIcon,
  RefreshCw,
  ScrollText,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useUpdater } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
import { ChangelogDialog } from "./ChangelogDialog";
import { UpdaterStatusLine } from "./UpdaterStatusLine";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";

// This build's version and commit, the way every version line here
// spells it: the local device's section on the desktop, the client
// line on a hostless shell.
export function BuildVersionLine() {
  return (
    <>
      {__APP_VERSION__}{" "}
      <span className="text-muted-foreground">({__APP_COMMIT__})</span>
    </>
  );
}

// The Version section of a device: the build it runs and the update
// action. One shape and one set of words on every device section. Only
// the updater it talks to differs, through the surrounding host scope
// (this window's own with no provider mounted, a peer's over its direct
// session inside one). Under the status line, the changelog, measured
// against the device's version, which previews a staged update.
export function VersionSection({
  version,
  installed,
}: {
  // The mono version line: this build's version and commit for the
  // local device, the welcome-confirmed version for a peer.
  version: ReactNode;
  // The same version as a string, which the changelog marks its
  // releases against: this build's tag, a peer's reported version
  // ("" before it reports one).
  installed: string;
}) {
  // Checking and installing are commands, so on a peer both wait for
  // its grant.
  const { canCommand } = useCommandAccess();
  const { state, check, isError, refetch } = useUpdater();
  // Which changelog is open: what the staged update brings, or all of it.
  const [changelog, setChangelog] = useState<"news" | "all" | null>(null);
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
              <ChangelogButton
                icon={Sparkles}
                label="See what's new"
                onOpen={() => setChangelog("news")}
              />
            )}
            <ChangelogButton
              icon={ScrollText}
              label="Changelog"
              onOpen={() => setChangelog("all")}
            />
            {kind === "unsupported" ? null : unavailable ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
              >
                <RefreshCw />
                Try again
              </Button>
            ) : ready ? (
              <RestartToUpdateButton version={ready.version} />
            ) : (
              <SimpleTooltip tip={blockedTip}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !canCommand}
                  onClick={() => check.mutate()}
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
            <UpdaterStatusLine state={state} />
          )}
        </div>
      </div>
      {changelog !== null && (
        <ChangelogDialog
          installed={installed}
          staged={changelog === "news" ? ready : null}
          restartButton={
            changelog === "news" &&
            ready && <RestartToUpdateButton version={ready.version} />
          }
          onClose={() => setChangelog(null)}
        />
      )}
    </section>
  );
}

// A door into the changelog, beside the update action: the whole
// changelog, or what a staged update brings. Quiet, so the update
// action stays the loud one.
export function ChangelogButton({
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
function RestartToUpdateButton({ version }: { version: string }) {
  const { remote } = useHostScope();
  const { canCommand } = useCommandAccess();
  const { install } = useUpdater();
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  return (
    <SimpleTooltip
      tip={canCommand ? undefined : peerReadOnlyNote("this device")}
    >
      <Button
        size="sm"
        disabled={install.isPending || !canCommand}
        aria-pressed={remote ? confirm.armed : undefined}
        onClick={() =>
          remote ? confirm.trigger(() => install.mutate()) : install.mutate()
        }
      >
        <RefreshCw />
        {confirm.armed
          ? "Click again to confirm"
          : `Restart to update to v${version}`}
      </Button>
    </SimpleTooltip>
  );
}
