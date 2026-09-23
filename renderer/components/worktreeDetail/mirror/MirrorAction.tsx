// The footer's mirror button on a worktree that is part of a mirror,
// on either side of it: the worktree a session runs on (the copy a
// "Mirror here" landed, or the original a "Mirror to" was started
// from), and the worktree at the far end, served to the device running
// it. One button per mirror, opening the dialog with the running
// mirror's status, history and controls. The dialog mounts under the
// RUNNER's scope, so its reads and controls go to the device running
// the session whichever page this is: the local page, a peer's page
// viewed from here, or the far end's own page. Nothing rendered on a
// worktree that is not mirrored, and nothing for a mirror whose
// session is not in hand or whose runner has no session up: nothing
// to drive it through.
import { type ReactNode, useState } from "react";
import { RefreshCw } from "lucide-react";
import { mirrorCopyOf, type MirrorSession } from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
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
import { useDeviceName } from "@/hooks/remote/useRemoteDevices";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { localDeviceId } from "@/lib/queryKeys";
import { FooterActionButton } from "../FooterActionButton";
import { MirrorManageDialog } from "./MirrorManageDialog";

export function MirrorAction({ worktree }: { worktree: Worktree }) {
  const links = useWorktreeMirrorLinks(worktree);
  return links.map((link) =>
    link.session === undefined || link.runnerApi === undefined ? null : (
      <MirrorLinkAction
        key={link.runnerDeviceId}
        worktree={worktree}
        link={link}
        session={link.session}
        runnerApi={link.runnerApi}
      />
    ),
  );
}

function MirrorLinkAction({
  worktree,
  link,
  session,
  runnerApi,
}: {
  worktree: Worktree;
  link: WorktreeMirrorLink;
  session: MirrorSession;
  runnerApi: HostApi;
}) {
  const { deviceId: pageDeviceId } = useHostScope();
  const nav = useWorktreeNav();
  // Open for one session: a stop ends with the session leaving the
  // list and the dialog with it, and a later mirror on the same
  // worktree starts closed.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const other = useDeviceName(link.otherDeviceId);
  // A stop that removed the copy this page is on leaves it the way a
  // delete does. A page on the other worktree stays.
  const copy = mirrorCopyOf(session, link.runnerDeviceId);
  const pageIsCopy =
    copy.deviceId === pageDeviceId && copy.worktreeId === worktree.id;
  return (
    <>
      <FooterActionButton
        icon={<RefreshCw />}
        label={`Mirror with ${other}`}
        onClick={() => setOpenFor(session.session)}
      />
      {openFor === session.session && (
        <RunnerScope deviceId={link.runnerDeviceId} api={runnerApi}>
          <MirrorManageDialog
            session={session}
            otherDeviceId={link.otherDeviceId}
            onClose={() => setOpenFor(null)}
            onStopped={() => {
              if (pageIsCopy) nav.toFallback(true);
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
function RunnerScope({
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
