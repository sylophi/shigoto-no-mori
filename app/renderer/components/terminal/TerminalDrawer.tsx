import {
  lazy,
  Suspense,
  useEffectEvent,
  useLayoutEffect,
  useState,
} from "react";
import { useClientFlag } from "@/hooks/config/useSidebarMarks";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useKeymapAction } from "@/hooks/ui/useKeymap";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { useHasLocalHost } from "@/lib/localHost";
import { openTerminalsInNewWindow } from "@/lib/newWindow";
import { type RendererApi, useApi } from "@/lib/runtime/pageApi";
import { paramToSlot } from "@/store/scriptSlot";
import {
  closeScriptTab,
  forgetDrawer,
  pickDrawerTab,
  setDrawerOpen,
  setDrawerSide,
  useDrawer,
  useDrawerSide,
} from "@/store/terminalDrawer";
import { setDrawerSize, useDrawerSizes } from "@/store/layout";
import type { Worktree } from "@shigomori/contracts/schemas";
import { TerminalScope } from "./TerminalScope";
import { TerminalDrawerView } from "@shigomori/ui/views/terminal/TerminalDrawerView.tsx";

// How much wider the window is kept for the drawer at its side, sent
// once per commit, so a page change between two worktrees with it open
// leaves the window be.
let widening: number | null = null;
function widenWindow(api: RendererApi, width: number): void {
  if (widening === null) {
    queueMicrotask(() => {
      void api.run(api.window.widen({ width: widening ?? 0 }));
      widening = null;
    });
  }
  widening = width;
}

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
// it has focus. A terminal moved to another worktree is followed there.
// Kept by the worktree's key: another worktree's drawer is another
// mount. With the setting on, the window widens by the drawer's width
// while it shows at the side.
export function TerminalDrawer({ worktree }: { worktree: Worktree }) {
  const api = useApi();
  const hasLocalHost = useHasLocalHost();
  const { deviceId, hasHost } = useHostScope();
  const { canCommand } = useCommandAccess();
  const side = useDrawerSide();
  const sizes = useDrawerSizes();
  const nav = useWorktreeNav();
  const ref = {
    deviceId,
    projectId: worktree.projectId,
    worktreeId: worktree.id,
  };
  const drawer = useDrawer(ref);
  const widens =
    useClientFlag("widenForSideTerminals") &&
    hasLocalHost &&
    side &&
    drawer.open;
  const widen = useEffectEvent(() => {
    let width = sizes.width;
    if (width === null) {
      width =
        document.querySelector<HTMLElement>('[data-slot="terminal-drawer"]')
          ?.offsetWidth ?? 0;
      // Its share of the page would grow with the window.
      setDrawerSize(true, width);
    }
    widenWindow(api, width);
  });
  useLayoutEffect(() => {
    if (!widens) return;
    widen();
    return () => widenWindow(api, 0);
  }, [widens, api]);
  useKeymapAction(
    "terminal",
    () => {
      const section = document.querySelector('[data-slot="terminal-drawer"]');
      if (!drawer.open || !section) {
        setDrawerOpen(ref, true);
      } else if (section.contains(document.activeElement)) {
        setDrawerOpen(ref, false);
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
  const close = () => setDrawerOpen(ref, false);
  const slots = drawer.scripts.flatMap((param) => paramToSlot(param) ?? []);
  return (
    <TerminalScope>
      <TerminalDrawerView
        side={side}
        size={side ? sizes.width : sizes.height}
        slideIn={slideIn}
        onSize={(size) => setDrawerSize(side, size)}
      >
        <Suspense>
          <TerminalTabs
            worktree={worktree}
            slots={slots}
            onCloseScript={(slot) => closeScriptTab(ref, slot)}
            picked={drawer.picked}
            onPick={(tab) => pickDrawerTab(ref, tab)}
            onEmpty={close}
            onMoved={(worktreeId, terminalId) =>
              nav.toTerminalOn(
                deviceId,
                worktree.projectId,
                worktreeId,
                terminalId,
              )
            }
            side={side}
            onDock={() => setDrawerSide(!side)}
            onPopOut={
              hasLocalHost
                ? () => {
                    openTerminalsInNewWindow(api, ref, {
                      scripts: drawer.scripts,
                      ...(drawer.picked !== null && { tab: drawer.picked }),
                    });
                    // Its tabs move to the window.
                    forgetDrawer(ref);
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
