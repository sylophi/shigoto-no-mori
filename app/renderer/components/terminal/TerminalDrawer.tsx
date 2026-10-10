import { lazy, Suspense } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { paramToSlot, type ScriptSlot } from "@/store/scriptSlot";
import {
  closeScriptTab,
  drawerKey,
  drawerOf,
  pickDrawerTab,
  setDrawerHeight,
  setDrawerOpen,
  useTerminalDrawer,
} from "@/store/terminalDrawer";
import type { Worktree } from "@shigomori/contracts/schemas";
import { TerminalDrawerView } from "@shigomori/ui/views/terminal/TerminalDrawerView.tsx";

// xterm comes with the first terminal opened, not with the page.
const TerminalTabs = lazy(() =>
  import("./TerminalTabs").then((module) => ({
    default: module.TerminalTabs,
  })),
);

// The drawer's shortest, and the share of the window it may take.
const MIN_HEIGHT = 120;
const MAX_SHARE = 0.8;

// A worktree's terminals and the script consoles opened in it, in the
// bottom drawer of its page, while it is open. Closing the last tab
// closes the drawer.
export function TerminalDrawer({ worktree }: { worktree: Worktree }) {
  const { deviceId } = useHostScope();
  const state = useTerminalDrawer();
  const key = drawerKey(deviceId, worktree.projectId, worktree.id);
  const drawer = drawerOf(state, key);
  if (!drawer.open) return null;
  const close = () => setDrawerOpen(key, false);
  const slots = drawer.scripts
    .map(paramToSlot)
    .filter((slot): slot is ScriptSlot => slot !== null);
  return (
    <TerminalDrawerView
      height={state.height}
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
          scripts={{
            worktree,
            slots,
            onClose: (slot) => closeScriptTab(key, slot),
          }}
          picked={drawer.picked}
          onPick={(tab) => pickDrawerTab(key, tab)}
          onEmpty={close}
          onHide={close}
        />
      </Suspense>
    </TerminalDrawerView>
  );
}
