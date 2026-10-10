import { lazy, Suspense } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  setDrawerHeight,
  setDrawerOpen,
  useTerminalDrawer,
} from "@/store/terminalDrawer";
import type { Worktree } from "@shigomori/contracts/schemas";
import { TerminalDrawerView } from "./TerminalDrawerView";

// xterm comes with the first terminal opened, not with the page.
const TerminalTabs = lazy(() =>
  import("./TerminalTabs").then((module) => ({
    default: module.TerminalTabs,
  })),
);

// The drawer's shortest, and the share of the window it may take.
const MIN_HEIGHT = 120;
const MAX_SHARE = 0.8;

export const drawerKey = (deviceId: string, worktree: Worktree): string =>
  `${deviceId}/${worktree.projectId}/${worktree.id}`;

// A worktree's terminals in the bottom drawer of its page, while it is
// open. Closing the last terminal closes the drawer.
export function TerminalDrawer({ worktree }: { worktree: Worktree }) {
  const { deviceId } = useHostScope();
  const { open, height } = useTerminalDrawer();
  const key = drawerKey(deviceId, worktree);
  if (!open.has(key)) return null;
  const close = () => setDrawerOpen(key, false);
  return (
    <TerminalDrawerView
      height={height}
      onHeight={(asked) =>
        setDrawerHeight(
          Math.round(
            Math.min(
              Math.max(asked, MIN_HEIGHT),
              window.innerHeight * MAX_SHARE,
            ),
          ),
        )
      }
    >
      <Suspense>
        <TerminalTabs
          owner={{
            kind: "worktree",
            projectId: worktree.projectId,
            worktreeId: worktree.id,
          }}
          onEmpty={close}
          onHide={close}
        />
      </Suspense>
    </TerminalDrawerView>
  );
}
