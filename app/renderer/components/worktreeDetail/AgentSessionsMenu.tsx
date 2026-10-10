// The agent sessions bound to the worktree (AgentSessionsMenuView),
// each row's actions on the worktree's host.
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  useIdleAgents,
  useResumeAgent,
  useUnbindAgent,
} from "@/hooks/worktrees/useWorktreeMutations";
import { canResume } from "@shigomori/ui/lib/agentSessions.ts";
import type { AgentSession, Worktree } from "@shigomori/contracts/schemas";
import { AgentSessionsMenuView, SessionRowView } from "./AgentSessionsMenuView";

export function AgentSessionsMenu({
  worktree,
  sessions,
  busy,
}: {
  worktree: Worktree;
  sessions: readonly AgentSession[];
  // A delete is under way: the sessions are about to go with it.
  busy: boolean;
}) {
  const idle = useIdleAgents();
  return (
    <AgentSessionsMenuView
      sessions={sessions}
      rows={sessions.map((session) => (
        <SessionRow
          key={`${session.harness}:${session.session}`}
          worktree={worktree}
          session={session}
          busy={busy}
        />
      ))}
      markIdle={{
        disabled: idle.isPending || busy,
        onClick: () =>
          idle.mutate({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
          }),
      }}
    />
  );
}

function SessionRow({
  worktree,
  session,
  busy,
}: {
  worktree: Worktree;
  session: AgentSession;
  busy: boolean;
}) {
  const { remote } = useHostScope();
  const resume = useResumeAgent();
  const unbind = useUnbindAgent();
  const vars = {
    projectId: worktree.projectId,
    worktreeId: worktree.id,
    harness: session.harness,
    session: session.session,
  };
  return (
    <SessionRowView
      session={session}
      // Only between turns: resuming a session mid-turn would start a
      // second copy while the first is still working.
      resumable={
        session.state === "idle" && canResume(session.harness) && !remote
      }
      resumeDisabled={resume.isPending || busy}
      unbindDisabled={unbind.isPending || busy}
      onResume={() => resume.mutate(vars)}
      onUnbind={() => unbind.mutate(vars)}
    />
  );
}
