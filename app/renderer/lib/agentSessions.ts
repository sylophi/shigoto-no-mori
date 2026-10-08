import type { StatusTone } from "@/components/ui/status-dot";
import type { AgentSession } from "@shared/schemas";

// How the app names a harness and a session's state (cli/agents.go).
// A harness without built-in support shows by the name it gave itself.
const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness] ?? harness;
}

export const AGENT_STATE_VIEW: Record<
  AgentSession["state"],
  { label: string; tone: StatusTone }
> = {
  working: { label: "Working", tone: "sky" },
  waiting: { label: "Needs you", tone: "amber" },
  idle: { label: "Idle", tone: "slate" },
};

// The state a worktree's sessions add up to: working while any is,
// then waiting on you while any is.
export function agentSessionsState(
  sessions: AgentSession[],
): AgentSession["state"] {
  if (sessions.some((s) => s.state === "working")) return "working";
  if (sessions.some((s) => s.state === "waiting")) return "waiting";
  return "idle";
}
