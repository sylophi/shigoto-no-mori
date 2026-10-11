// The footer's Terminal button: shows or hides the page's terminal
// drawer, and so do its keys (the keymap's terminal, Ctrl+`), which
// also focus it. A peer's terminals ride its command grant, so a
// read-only peer's footer leaves it out.
import { SquareTerminal } from "lucide-react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useBinding, useKeymapAction } from "@/hooks/ui/useKeymap";
import {
  drawerKey,
  drawerOf,
  setDrawerOpen,
  useTerminalDrawer,
} from "@/store/terminalDrawer";
import type { Worktree } from "@shigomori/contracts/schemas";
import { FooterActionButtonView } from "@shigomori/ui/views/worktreeDetail/FooterActionButtonView.tsx";
import { LABEL_RANK } from "@shigomori/ui/views/worktreeDetail/FooterVerbView.tsx";

export function TerminalButton({ worktree }: { worktree: Worktree }) {
  const { deviceId, hasHost } = useHostScope();
  const { canCommand } = useCommandAccess();
  const state = useTerminalDrawer();
  const keys = useBinding("terminal");
  const key = drawerKey(deviceId, worktree.projectId, worktree.id);
  const open = drawerOf(state, key).open;
  const shown = canCommand && hasHost;
  // Closed, it opens, and its terminal takes focus as it attaches. Open,
  // it takes focus, or closes when it has it.
  useKeymapAction(
    "terminal",
    () => {
      const drawer = document.querySelector('[data-slot="terminal-drawer"]');
      if (!open || !drawer) {
        setDrawerOpen(key, true);
      } else if (drawer.contains(document.activeElement)) {
        setDrawerOpen(key, false);
      } else {
        drawer.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
      }
    },
    { enabled: shown },
  );
  if (!shown) return null;
  return (
    <FooterActionButtonView
      rank={LABEL_RANK.terminal}
      icon={<SquareTerminal />}
      label="Terminal"
      tip={keys.label}
      onClick={() => setDrawerOpen(key, !open)}
    />
  );
}
