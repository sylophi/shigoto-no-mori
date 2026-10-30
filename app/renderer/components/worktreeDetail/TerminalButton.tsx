// The footer's Terminal button: shows or hides the worktree's terminal
// drawer, its keys named in its tip (TerminalDrawer binds them). A
// peer's terminals ride its command grant, so a read-only peer's footer
// leaves it out.
import { SquareTerminal } from "lucide-react";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useBinding } from "@/hooks/ui/useKeymap";
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
  if (!canCommand || !hasHost) return null;
  return (
    <FooterActionButtonView
      rank={LABEL_RANK.terminal}
      icon={<SquareTerminal />}
      label="Terminal"
      tip={keys.label}
      expanded={open}
      onClick={() => setDrawerOpen(key, !open)}
    />
  );
}
