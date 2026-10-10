// The footer's mirror button on a worktree that is part of a mirror,
// on either side of it: the original a session runs on (on the device
// holding it), and the copy at the far end, served to that device. One
// button per mirror, its icon in the mirror's status tone, opening the
// dialog with the running mirror's status, history and controls. The
// dialog mounts under the RUNNER's scope, so its reads and controls go
// to the device running the session whichever page this is: the local
// page, a peer's page viewed from here, or the far end's own page.
// Nothing rendered on a worktree that is not mirrored, or for a mirror
// whose session is not in hand. A runner with no session up leaves the
// button disabled, saying so: nothing to drive the mirror through, but
// the worktree is still mirrored.
import { type ReactNode, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { MirrorSession } from "@shigomori/contracts/modules/mirror";
import type { Worktree } from "@shigomori/contracts/schemas";
import {
  type HostApi,
  HostScopeProvider,
  LocalHostScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import {
  useWorktreeMirrorLinks,
  type WorktreeMirrorLink,
} from "@/hooks/remote/useMirrors";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { localDeviceId } from "@/lib/queryKeys";
import { FooterActionButtonView } from "../FooterActionButtonView";
import { LABEL_RANK } from "../FooterVerbView";
import { TONE_TEXT } from "@shigomori/ui/primitives/status-dot.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { MirrorManageDialog } from "./MirrorManageDialog";
import { useMirrorView } from "./useMirrorView";

export function MirrorAction({ worktree }: { worktree: Worktree }) {
  const links = useWorktreeMirrorLinks(worktree);
  return links.map((link) =>
    link.session === undefined ? null : (
      <MirrorLinkAction
        key={link.runnerDeviceId}
        worktree={worktree}
        link={link}
        session={link.session}
      />
    ),
  );
}

function MirrorLinkAction({
  worktree,
  link,
  session,
}: {
  worktree: Worktree;
  link: WorktreeMirrorLink;
  session: MirrorSession;
}) {
  const { deviceId: pageDeviceId } = useHostScope();
  const nav = useWorktreeNav();
  // Open for this link, whatever its session id: an ignore change
  // re-opens the session under a new one, and the dialog stays. A stop
  // ends with the link leaving the page and the dialog with it.
  const [open, setOpen] = useState(false);
  // A runner that went away takes the dialog with it, and it stays
  // closed when the runner is back.
  if (open && link.runnerApi === undefined) setOpen(false);
  const mirror = useMirrorView(link, session);
  const { view, names } = mirror;
  // A stop that removed the copy this page is on (the session's remote
  // side) leaves it the way a delete does. The original's page stays.
  const pageIsCopy =
    session.deviceId === pageDeviceId && session.worktreeId === worktree.id;
  const runnerApi = link.runnerApi;
  return (
    <>
      <FooterActionButtonView
        rank={LABEL_RANK.mirror}
        icon={
          <RefreshCw
            className={cn(
              TONE_TEXT[view.tone],
              view.spinning && "animate-spin",
            )}
          />
        }
        label="Mirroring"
        tip={`${view.label} with ${names.other}${view.detail === "" ? "" : `: ${view.detail}`}`}
        disabledReason={runnerApi === undefined ? view.detail : undefined}
        onClick={() => setOpen(true)}
      />
      {open && runnerApi !== undefined && (
        <RunnerScope deviceId={link.runnerDeviceId} api={runnerApi}>
          <MirrorManageDialog
            session={session}
            {...mirror}
            onClose={() => setOpen(false)}
            onStopped={(removedCopy) => {
              if (pageIsCopy && removedCopy) {
                nav.toFallback([worktree.id], true);
              }
            }}
          />
        </RunnerScope>
      )}
    </>
  );
}

// The runner's scope over the dialog: this machine re-pinned outright
// (the page may be a peer's, viewed from here), or the peer's
// provider.
export function RunnerScope({
  deviceId,
  api,
  children,
}: {
  deviceId: string;
  api: HostApi;
  children: ReactNode;
}) {
  if (deviceId === localDeviceId) {
    return <LocalHostScope>{children}</LocalHostScope>;
  }
  return (
    <HostScopeProvider deviceId={deviceId} api={api}>
      {children}
    </HostScopeProvider>
  );
}
