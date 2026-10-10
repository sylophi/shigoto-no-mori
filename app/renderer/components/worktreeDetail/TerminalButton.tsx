// The footer's Terminal button: shows or hides the page's terminal
// drawer. A peer's terminals ride its command grant, so a read-only
// peer's footer leaves it out.
import { SquareTerminal } from "lucide-react";
import { drawerKey } from "@/components/terminal/TerminalDrawer";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { setDrawerOpen, useTerminalDrawer } from "@/store/terminalDrawer";
import type { Worktree } from "@shigomori/contracts/schemas";
import { FooterActionButtonView } from "./FooterActionButtonView";
import { LABEL_RANK } from "./FooterVerbView";

export function TerminalButton({ worktree }: { worktree: Worktree }) {
  const { deviceId, hasHost } = useHostScope();
  const { canCommand } = useCommandAccess();
  const { open } = useTerminalDrawer();
  if (!canCommand || !hasHost) return null;
  const key = drawerKey(deviceId, worktree);
  return (
    <FooterActionButtonView
      rank={LABEL_RANK.terminal}
      icon={<SquareTerminal />}
      label="Terminal"
      onClick={() => setDrawerOpen(key, !open.has(key))}
    />
  );
}
