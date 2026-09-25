import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useUpdater } from "@/hooks/system/useUpdater";
import { CONFIRM_QUICK_MS, useConfirmTwice } from "@/hooks/ui/useConfirmTwice";
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
// session inside one). A remote restart is the one action here that
// ends a session someone else may be using, so it asks for a second
// click where the local one has the busy dialog.
export function VersionSection({
  version,
}: {
  // The mono version line: this build's version and commit for the
  // local device, the welcome-confirmed version for a peer.
  version: ReactNode;
}) {
  const { remote } = useHostScope();
  // Checking and installing are commands, so on a peer both wait for
  // its grant.
  const { canCommand } = useCommandAccess();
  const { state, check, install, isError, refetch } = useUpdater();
  const confirm = useConfirmTwice(CONFIRM_QUICK_MS);
  const kind = state?.kind ?? "idle";
  const ready = state?.kind === "ready" ? state : null;
  const busy = kind === "checking" || kind === "downloading";
  const blockedTitle = canCommand ? undefined : peerReadOnlyNote("this device");
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
          {kind === "unsupported" ? null : unavailable ? (
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RefreshCw />
              Try again
            </Button>
          ) : ready ? (
            <Button
              size="sm"
              disabled={install.isPending || !canCommand}
              title={blockedTitle}
              aria-pressed={remote ? confirm.armed : undefined}
              onClick={() =>
                remote
                  ? confirm.trigger(() => install.mutate())
                  : install.mutate()
              }
            >
              <RefreshCw />
              {confirm.armed
                ? "Click again to confirm"
                : `Restart to update to v${ready.version}`}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canCommand}
              title={blockedTitle}
              onClick={() => check.mutate()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {kind === "checking" ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
        <div className="-mt-1 block">
          {unavailable ? (
            <span className="text-xs text-muted-foreground">
              Couldn&apos;t read the update status.
            </span>
          ) : (
            <UpdaterStatusLine state={state} />
          )}
        </div>
      </div>
    </section>
  );
}
