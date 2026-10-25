import { lazy, Suspense, useState } from "react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useHasLocalHost } from "@/lib/localHost";
import { openTerminalsInNewWindow } from "@/lib/newWindow";
import { useApi } from "@/lib/runtime/pageApi";
import { paramToSlot, type ScriptSlot } from "@/store/scriptSlot";
import {
  closeScriptTab,
  drawerKey,
  drawerOf,
  forgetDrawer,
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
// drawer of its page, while it is open and the device drawer isn't.
// Closing the last tab closes the drawer.
export function TerminalDrawer({ worktree }: { worktree: Worktree }) {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
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
  if (!drawer.open || state.device.open) return null;
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
          onPopOut={
            hasLocalHost
              ? () => {
                  openTerminalsInNewWindow(
                    api,
                    {
                      deviceId,
                      projectId: worktree.projectId,
                      worktreeId: worktree.id,
                    },
                    {
                      scripts: drawer.scripts,
                      ...(drawer.picked !== null && { tab: drawer.picked }),
                    },
                  );
                  // Its tabs move to the window.
                  forgetDrawer(key);
                }
              : undefined
          }
          onHide={close}
        />
      </Suspense>
    </TerminalDrawerView>
  );
}

// The keymap's terminal on a drawer. Closed, it opens, and its terminal
// takes focus as it attaches. Open, it takes focus, or closes when it
// has it.
export function toggleTerminalDrawer(
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  const drawer = document.querySelector('[data-slot="terminal-drawer"]');
  if (!open || !drawer) {
    setOpen(true);
  } else if (drawer.contains(document.activeElement)) {
    setOpen(false);
  } else {
    drawer.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
  }
}
