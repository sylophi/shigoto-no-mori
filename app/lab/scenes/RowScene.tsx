// One inbox row: gentle-gecko on the Thinkpad, with changes, a commit to
// push and the middle PR of a stack. The marketing page's close-up, with
// its parts named for the pins (the row-* slots).
import { InboxRowView } from "@/components/sidebar/inbox/InboxRowView";
import {
  NOW,
  QUIET_LOOK,
  badgeOf,
  iconSrcOf,
  pullRequestOf,
  worktreeById,
} from "./world";

export function RowScene() {
  const { worktree, project, deviceId } = worktreeById("a1b2c3d4e5f6");
  return (
    <div data-slot="sidebar-row" className="w-60 px-2">
      <InboxRowView
        worktree={worktree}
        project={project}
        projectIconSrc={iconSrcOf(project.name)}
        now={NOW}
        {...pullRequestOf(project.id, worktree.branch)}
        device={badgeOf(deviceId)}
        look={QUIET_LOOK}
        shelf={null}
        resident={null}
        forwardTip={undefined}
        showDeviceBadges
      />
    </div>
  );
}
