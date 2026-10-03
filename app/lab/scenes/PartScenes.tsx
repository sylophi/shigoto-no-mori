// The close-ups: one part of the app on its own, outside a window.
import { InboxRowView } from "@/components/sidebar/inbox/InboxRowView";
import { GENTLE_GECKO_ID } from "../fixtures";
import { LaunchSection } from "./WorktreeDetailPane";
import {
  NOW,
  QUIET_LOOK,
  badgeOf,
  iconSrcOf,
  pullRequestOf,
  worktreeById,
} from "./world";

// One inbox row at the sidebar's width: gentle-gecko on the Thinkpad,
// with changes, a commit to push and the middle PR of a stack.
export function RowScene() {
  const { worktree, project, deviceId } = worktreeById(GENTLE_GECKO_ID);
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

// A worktree's Launch section: the tools and the package.json scripts.
export function LaunchRowScene() {
  return (
    <div data-slot="launch-row" className="p-6">
      <LaunchSection />
    </div>
  );
}
