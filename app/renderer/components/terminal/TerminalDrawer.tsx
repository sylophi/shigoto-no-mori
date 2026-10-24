import { lazy, Suspense, useState } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { paramToSlot, type ScriptSlot } from "@/store/scriptSlot";
import {
  closeScriptTab,
  drawerKey,
  drawerOf,
  pickDrawerTab,
  setDrawerOpen,
  setDrawerSide,
  setDrawerSize,
  useDrawerSide,
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

// A worktree's terminals and the script consoles opened in it, in the
// drawer of its page, while it is open. Closing the last tab closes the
// drawer.
export function TerminalDrawer({ worktree }: { worktree: Worktree }) {
  const { deviceId } = useHostScope();
  const state = useTerminalDrawer();
  const side = useDrawerSide();
  const key = drawerKey(deviceId, worktree.projectId, worktree.id);
  const drawer = drawerOf(state, key);
  // Slides in when it opens on the page it was closed on (its toggle,
  // a console), not when a page change shows it open.
  const [seen, setSeen] = useState({ key, open: drawer.open });
  const [slideIn, setSlideIn] = useState(false);
  if (seen.key !== key || seen.open !== drawer.open) {
    setSeen({ key, open: drawer.open });
    setSlideIn(seen.key === key && drawer.open);
  }
  if (!drawer.open) return null;
  const close = () => setDrawerOpen(key, false);
  const slots = drawer.scripts
    .map(paramToSlot)
    .filter((slot): slot is ScriptSlot => slot !== null);
  return (
    <TerminalDrawerView
      side={side}
      size={side ? state.width : state.height}
      slideIn={slideIn}
      onSize={setDrawerSize}
    >
      <Suspense>
        <TerminalTabs
          worktree={worktree}
          slots={slots}
          onCloseScript={(slot) => closeScriptTab(key, slot)}
          picked={drawer.picked}
          onPick={(tab) => pickDrawerTab(key, tab)}
          onEmpty={close}
          side={side}
          onDock={() => setDrawerSide(!side)}
          onHide={close}
        />
      </Suspense>
    </TerminalDrawerView>
  );
}
