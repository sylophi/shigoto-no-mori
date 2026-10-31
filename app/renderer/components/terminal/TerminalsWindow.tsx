// A worktree's terminals in a window of their own, popped out of its
// page's drawer: the tabs fill the window, their row its title bar.
// Its script consoles and pick live in the route's search, so a
// relaunch reopens the window as it was left. The window closes with
// its last tab, or when its worktree is gone.
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Worktree } from "@shigomori/contracts/schemas";
import { WorktreeMissingView } from "@shigomori/ui/views/shared/WorktreeMissingView.tsx";
import { useRouteWorktree } from "@/hooks/worktrees/useRouteWorktree";
import type { TerminalsSearch } from "@/lib/newWindow";
import { paramToSlot, slotToParam } from "@/store/scriptSlot";
import { TerminalScope } from "./TerminalScope";
import { TerminalTabs } from "./TerminalTabs";

export function TerminalsWindow() {
  const { worktree, missing } = useRouteWorktree();
  if (!worktree) {
    return <WorktreeMissingView {...missing} onBack={() => window.close()} />;
  }
  return <WindowTabs worktree={worktree} />;
}

function WindowTabs({ worktree }: { worktree: Worktree }) {
  const search = useSearch({ strict: false }) as TerminalsSearch;
  const navigate = useNavigate();
  const update = (change: Partial<TerminalsSearch>) =>
    void navigate({
      to: ".",
      search: { ...search, ...change },
      replace: true,
    } as never);
  const slots = (search.scripts ?? []).flatMap(
    (param) => paramToSlot(param) ?? [],
  );
  return (
    <TerminalScope>
      <div className="h-full bg-card">
        <TerminalTabs
          worktree={worktree}
          slots={slots}
          onCloseScript={(closed) =>
            update({
              scripts: search.scripts?.filter(
                (param) => param !== slotToParam(closed),
              ),
            })
          }
          picked={search.tab ?? null}
          onPick={(tab) => update({ tab })}
          onEmpty={() => window.close()}
          titleBar
        />
      </div>
    </TerminalScope>
  );
}
