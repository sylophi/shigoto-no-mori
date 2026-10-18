import type { StatusTone } from "../primitives/status-dot.tsx";
import type { AgentSession } from "@shigomori/contracts/schemas";

// How the app shows a session's state.
export const AGENT_STATE_VIEW: Record<
  AgentSession["state"],
  { label: string; tone: StatusTone }
> = {
  working: { label: "Working", tone: "sky" },
  waiting: { label: "Needs you", tone: "amber" },
  idle: { label: "Idle", tone: "slate" },
};

// The state a worktree's sessions add up to: waiting on you while any
// is, since that is the one to act on, then working while any is.
export function agentSessionsState(
  sessions: readonly AgentSession[],
): AgentSession["state"] {
  if (sessions.some((s) => s.state === "waiting")) return "waiting";
  if (sessions.some((s) => s.state === "working")) return "working";
  return "idle";
}

// The session that speaks for a worktree waiting on you: the one that
// started waiting last.
export function waitingSession(
  sessions: readonly AgentSession[] | undefined,
): AgentSession | undefined {
  return sessions
    ?.filter((s) => s.state === "waiting")
    .reduce<AgentSession | undefined>(
      (last, s) => (last && last.at >= s.at ? last : s),
      undefined,
    );
}
