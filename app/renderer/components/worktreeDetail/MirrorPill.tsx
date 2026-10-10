// The worktree header's mirror line: what this worktree's live mirror
// is doing, if it has one. One line per mirror the worktree is part
// of, on either side of it (hooks/remote/useMirrors.ts
// useWorktreeMirrorLinks): status, conflicts and problems, and the
// other device by name. A peer's mirror whose session is not in hand
// yet is named alone. Quiet when there is nothing to say. The details
// and the controls live in the dialog behind the footer's Mirror
// button (mirror/MirrorAction.tsx), which drives the session through
// the device running it.
import type { MirrorSession } from "@shigomori/contracts/modules/mirror";
import type { Worktree } from "@shigomori/contracts/schemas";
import { MirrorConflictsChipView } from "@shigomori/ui/views/worktreeDetail/MirrorConflictsView.tsx";
import { useMirrorView } from "@/components/worktreeDetail/mirror/useMirrorView";
import {
  useWorktreeMirrorLinks,
  type WorktreeMirrorLink,
} from "@/hooks/remote/useMirrors";
import { useDeviceProperName } from "@/hooks/remote/useRemoteDevices";
import {
  MirrorLineView,
  MirrorPillView,
  MirrorStatusChipView,
} from "@shigomori/ui/views/worktreeDetail/MirrorPillView.tsx";

export function MirrorPill({ worktree }: { worktree: Worktree }) {
  const links = useWorktreeMirrorLinks(worktree);
  if (links.length === 0) return null;
  return (
    <MirrorPillView
      lines={links.map((link) => (
        <SessionLine key={link.runnerDeviceId} link={link} />
      ))}
    />
  );
}

function SessionLine({ link }: { link: WorktreeMirrorLink }) {
  const other = useDeviceProperName(link.otherDeviceId);
  const { session } = link;
  if (session === undefined) {
    return (
      <MirrorLineView
        chip={<MirrorStatusChipView tone="emerald" label="Mirrored" />}
        other={other}
      />
    );
  }
  return <SessionChip link={link} session={session} />;
}

function SessionChip({
  link,
  session,
}: {
  link: WorktreeMirrorLink;
  session: MirrorSession;
}) {
  const { view, names, revealUnder } = useMirrorView(link, session);
  return (
    <MirrorLineView
      chip={
        view.showConflicts ? (
          <MirrorConflictsChipView
            session={session}
            tone={view.tone}
            label={view.label}
            names={names}
            revealUnder={revealUnder}
          />
        ) : (
          <MirrorStatusChipView
            tone={view.tone}
            label={view.label}
            tip={view.detail}
            spinning={view.spinning}
          />
        )
      }
      other={names.other}
    />
  );
}
