import {
  Bot,
  FilePen,
  Globe,
  ListChecks,
  type LucideIcon,
  MessageCircleQuestion,
  ShieldQuestion,
  SquareTerminal,
} from "lucide-react";
import type { AgentSession } from "@shared/schemas";
import { pluralize } from "./pluralize";
import { AGENT_STATE_VIEW, harnessLabel } from "./agentSessions";

// What kind of prompt a waiting session is on, read off its tool
// (cli/agents.go waitNeed): an icon for it, what the agent wants in a
// verb phrase ("wants to run") and as a sentence about its harness
// ("Codex wants to run"), and the question, command, file or URL it is
// about, when there is one. A prompt with no tool reads as plainly
// needing you.
interface NeedView {
  Icon: LucideIcon;
  verb: string;
  sentence: string;
  text: string | undefined;
}

const EDITS = new Set(["Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
const COMMANDS = new Set(["Bash", "PowerShell", "shell", "exec_command"]);

export function needView(session: AgentSession): NeedView {
  const [Icon, verb] = needKind(session.tool);
  return {
    Icon,
    verb,
    sentence: `${harnessLabel(session.harness)} ${verb}`,
    text: session.need,
  };
}

function needKind(tool: string | undefined): [LucideIcon, string] {
  if (tool === undefined) return [Bot, "needs you"];
  if (tool === "AskUserQuestion") return [MessageCircleQuestion, "asks"];
  if (tool === "ExitPlanMode") {
    return [ListChecks, "has a plan for you to review"];
  }
  if (COMMANDS.has(tool)) return [SquareTerminal, "wants to run"];
  if (EDITS.has(tool)) return [FilePen, "wants to edit"];
  if (tool === "Write") return [FilePen, "wants to write"];
  if (tool === "WebFetch") return [Globe, "wants to fetch"];
  if (tool === "WebSearch") return [Globe, "wants to search"];
  return [ShieldQuestion, `wants to use ${toolName(tool)}`];
}

// An MCP tool (mcp__<server>__<tool>) by its own name and its server's.
function toolName(tool: string): string {
  const [prefix, server, ...name] = tool.split("__");
  if (prefix !== "mcp" || server === undefined || name.length === 0) {
    return tool;
  }
  return `${name.join("__")} from ${server}`;
}

// The sentence and what it is about, in a line, for a tooltip:
// "Codex wants to run: pnpm test".
export function needLine(session: AgentSession): string {
  const { sentence, text } = needView(session);
  return text ? `${sentence}: ${text}` : sentence;
}

// A session's state: as a sentence about its harness ("Codex wants to
// run", "Claude Code is working"), or without it where the harness's
// name already leads ("Wants to run", "Working").
export function stateLabel(
  session: AgentSession,
  withHarness: boolean,
): string {
  if (session.state === "waiting") {
    const { verb, sentence } = needView(session);
    return withHarness
      ? sentence
      : verb.charAt(0).toUpperCase() + verb.slice(1);
  }
  if (!withHarness) return AGENT_STATE_VIEW[session.state].label;
  return `${harnessLabel(session.harness)} is ${session.state}`;
}

// "2 agents need you".
export function agentsNeedYou(count: number): string {
  return pluralize(count, "agent needs you", "agents need you");
}
