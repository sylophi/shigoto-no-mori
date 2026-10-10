// The Options popover's "Open in new window": this worktree's page in
// another window. Desktop only.
import { AppWindow } from "lucide-react";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { hasLocalHost } from "@/lib/localHost";
import { openWorktreeInNewWindow } from "@/lib/newWindow";
import type { Worktree } from "@shigomori/contracts/schemas";
import { OptionActionView } from "@shigomori/ui/views/worktreeDetail/WorktreeOptionsView.tsx";

export function NewWindowOption({ worktree }: { worktree: Worktree }) {
  const { deviceId } = useHostScope();
  if (!hasLocalHost) return null;
  return (
    <OptionActionView
      icon={<AppWindow />}
      label="Open in new window"
      description="This page in a window of its own."
      onClick={() =>
        openWorktreeInNewWindow({
          deviceId,
          projectId: worktree.projectId,
          worktreeId: worktree.id,
        })
      }
    />
  );
}
