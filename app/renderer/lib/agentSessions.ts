import type { StatusTone } from "@/components/ui/status-dot";
import type { AgentSession } from "@shigomori/contracts/schemas";

// How the app names a harness and a session's state (engine Agents.ts).
// A harness without built-in support shows by the name it gave itself.
const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness] ?? harness;
}

// The harnesses with built-in support are the ones `sm agents resume`
// knows how to resume.
export function canResume(harness: string): boolean {
  return Object.hasOwn(HARNESS_LABELS, harness);
}

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
