import { lazy, Suspense, useState } from "react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useKeymapAction } from "@/hooks/ui/useKeymap";
import { useHasLocalHost } from "@/lib/localHost";
import { openTerminalsInNewWindow } from "@/lib/newWindow";
import { useApi } from "@/lib/runtime/pageApi";
import { paramToSlot } from "@/store/scriptSlot";
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
import { TerminalScope } from "./TerminalScope";
import { TerminalDrawerView } from "@shigomori/ui/views/terminal/TerminalDrawerView.tsx";

// xterm comes with the first terminal opened, not with the page.
const TerminalTabs = lazy(() =>
  import("./TerminalTabs").then((module) => ({
    default: module.TerminalTabs,
  })),
);

// A worktree's terminals and the script consoles opened in it, in the
// drawer its pages share, while it is open. Closing the last tab closes
// the drawer. The keymap's terminal (Ctrl+`) opens it and its terminal
// takes focus as it attaches. Open, the keys focus it, or close it when
// it has focus. Kept by the worktree's key: another worktree's drawer
// is another mount.
export function TerminalDrawer({ worktree }: { worktree: Worktree }) {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  const { deviceId, hasHost } = useHostScope();
  const { canCommand } = useCommandAccess();
  const state = useTerminalDrawer();
  const side = useDrawerSide();
  const key = drawerKey(deviceId, worktree.projectId, worktree.id);
  const drawer = drawerOf(state, key);
  useKeymapAction(
    "terminal",
    () => {
      const section = document.querySelector('[data-slot="terminal-drawer"]');
      if (!drawer.open || !section) {
        setDrawerOpen(key, true);
      } else if (section.contains(document.activeElement)) {
        setDrawerOpen(key, false);
      } else {
        section.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
      }
    },
    { enabled: canCommand && hasHost },
  );
  // Slides in when it opens, not when a page shows it open.
  const [wasOpen, setWasOpen] = useState(drawer.open);
  const [slideIn, setSlideIn] = useState(false);
  if (wasOpen !== drawer.open) {
    setWasOpen(drawer.open);
    setSlideIn(drawer.open);
  }
  if (!drawer.open) return null;
  const close = () => setDrawerOpen(key, false);
  const slots = drawer.scripts.flatMap((param) => paramToSlot(param) ?? []);
  return (
    <TerminalScope>
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
    </TerminalScope>
  );
}
