// An agent session's life between its harness's hook events: the state
// one event moves it to, and the text the app shows of it. Agents.ts
// stores the sessions and reads the events.
import { createHash } from "node:crypto";

// A session's states: working through a turn, waiting on the user
// mid-turn (a permission prompt), or idle (the turn ended).
export type AgentState = "working" | "waiting" | "idle";

// One session bound to a worktree, in the order `sm --json` writes it.
// Harness is "claude", "codex", or whatever a harness without built-in
// support names itself.
export type AgentSession = {
  readonly harness: string;
  readonly session: string;
  readonly state: AgentState;
  // When the state last changed, in ms.
  readonly at: number;
  // The permission prompts it waits on, oldest first, each its call
  // (toolWait), its tool and what it asks (waitEntry).
  readonly waits?: ReadonlyArray<string>;
  // What the session is about: its custom title, else its first prompt.
  readonly title?: string;
  // What it waits on while waiting: the newest open prompt's tool, and
  // the question it asks or the one input that says what the call does
  // (waitNeed).
  readonly tool?: string;
  readonly need?: string;
  // The message its last turn ended on, while idle.
  readonly message?: string;
};

// What a harness hands its hooks on stdin: the fields Claude Code and
// Codex share, Notification's type, a Codex subagent's own thread id,
// the tool a permission prompt or a tool's end is about, the prompt
// (with the session's custom title, Claude Code) a turn starts from,
// and the message it ends on.
export type AgentEvent = {
  readonly name: string;
  readonly session: string;
  readonly cwd: string;
  readonly notificationType: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly prompt: string;
  readonly sessionTitle: string;
  readonly lastMessage: string;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

// An event as the hooks send it, or undefined when it names no session.
export function parseAgentEvent(raw: string): AgentEvent | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return undefined;
  }
  const fields = doc as Record<string, unknown>;
  const event = {
    name: text(fields.hook_event_name),
    session: text(fields.session_id),
    cwd: text(fields.cwd),
    notificationType: text(fields.notification_type),
    agentId: text(fields.agent_id),
    toolName: text(fields.tool_name),
    toolInput: fields.tool_input ?? null,
    prompt: text(fields.prompt),
    sessionTitle: text(fields.session_title),
    lastMessage: text(fields.last_assistant_message),
  };
  return event.session === "" ? undefined : event;
}

// A value as JSON with every object's keys sorted, the one form two
// spellings of the same input share.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// One permission prompt, as the tool call it asks about. The prompt
// carries no call id, so the call is its tool and input, which its
// PostToolUse repeats. A question's PostToolUse adds the answers to
// it, so those are left out.
export function toolWait(event: AgentEvent): string {
  let input = event.toolInput;
  if (
    event.toolName === "AskUserQuestion" &&
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input)
  ) {
    const {
      answers: _answers,
      annotations: _annotations,
      ...rest
    } = input as Record<string, unknown>;
    input = rest;
  }
  return createHash("sha256")
    .update(`${event.toolName}\0${canonicalJson(input)}`)
    .digest("hex")
    .slice(0, 16);
}

// One open prompt as waits keeps it: its call, tab, its tool, tab, what
// it asks. clipLine folds whitespace, so no tab is in the text.
const waitEntry = (event: AgentEvent) =>
  `${toolWait(event)}\t${event.toolName}\t${waitNeed(event)}`;

// An entry's call, and its tool and what it asks.
function waitAsk(entry: string) {
  const [call = "", tool = "", ...need] = entry.split("\t");
  return { call, tool, need: need.join("\t") };
}

// How long the text a session keeps may run, in characters: a line for
// a title or a prompt's call, a few for a closing message.
export const AGENT_LINE_MAX = 120;
export const AGENT_MESSAGE_MAX = 400;

// What a permission prompt asks, in a line: the question, or the one
// input that says what the call does (a command, a file, a URL), a path
// inside the session's cwd (the worktree) relative to it. Empty when
// nothing says more than the tool (a plan to review).
function waitNeed(event: AgentEvent): string {
  const input =
    typeof event.toolInput === "object" && event.toolInput !== null
      ? (event.toolInput as Record<string, unknown>)
      : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (questions.length > 0) {
    const first: unknown = questions[0];
    const question =
      typeof first === "object" && first !== null && "question" in first
        ? text(first.question)
        : "";
    return clipLine(question, AGENT_LINE_MAX);
  }
  const cwd = event.cwd.replace(/\/$/, "");
  for (const key of ["command", "file_path", "url", "path", "pattern"]) {
    let value = text(input[key]);
    if (value === "") continue;
    if (event.cwd !== "" && value.startsWith(`${cwd}/`)) {
      value = value.slice(cwd.length + 1);
    }
    return clipLine(value, AGENT_LINE_MAX);
  }
  return "";
}

// Text on one line, whitespace runs folded to a space, cut to `max`
// characters with an ellipsis.
export function clipLine(line: string, max: number): string {
  const folded = line.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...folded];
  return chars.length <= max ? folded : `${chars.slice(0, max - 1).join("")}…`;
}

// Whether any of a worktree's sessions is working: what the agent-
// working shelf takes.
export const anyWorking = (sessions: ReadonlyArray<AgentSession>) =>
  sessions.some(({ state }) => state === "working");

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

// Moves a session through one event: the session it becomes, or
// "unbind" when its binding goes, or undefined when the event changes
// nothing. A session waits while any permission prompt is open, and a
// tool's end closes only its own prompt: tools run side by side, and
// PostToolUse, installed async, can land after a later prompt or after
// the turn's Stop. It also keeps what the app says of the session: its
// title, what the newest prompt asks, and the message the last turn
// ended on.
export function applyAgentEvent(
  // An unbound session's state is "": any change of state binds it.
  session: Omit<AgentSession, "state"> & { readonly state: AgentState | "" },
  event: AgentEvent,
  now: number,
): AgentSession | "unbind" | undefined {
  const waits = session.waits ?? [];
  let state: AgentState | "" = session.state;
  let nextWaits = waits;
  let title = session.title ?? "";
  let message = session.message ?? "";
  switch (event.name) {
    case "UserPromptSubmit":
      state = "working";
      nextWaits = [];
      message = "";
      if (event.sessionTitle !== "") {
        title = clipLine(event.sessionTitle, AGENT_LINE_MAX);
      } else if (title === "") {
        title = clipLine(event.prompt, AGENT_LINE_MAX);
      }
      break;
    case "PermissionRequest":
      state = "waiting";
      nextWaits = [...waits, waitEntry(event)];
      break;
    case "PostToolUse":
    case "PostToolUseFailure": {
      // Nearly every tool's end, with no prompt open: no need to hash
      // its input (a whole file, for a Write).
      if (waits.length === 0) return undefined;
      const call = toolWait(event);
      const index = waits.findIndex((entry) => waitAsk(entry).call === call);
      if (index < 0) return undefined;
      nextWaits = waits.toSpliced(index, 1);
      if (nextWaits.length === 0) state = "working";
      break;
    }
    case "Notification":
      // Claude Code's "waiting for your input" nudge, a minute after a
      // turn ends, and the only one that follows an interrupt.
      if (event.notificationType !== "idle_prompt") return undefined;
      state = "idle";
      nextWaits = [];
      break;
    case "Stop":
    case "StopFailure":
    case "Interrupt":
      state = "idle";
      nextWaits = [];
      if (event.lastMessage !== "") {
        message = clipLine(event.lastMessage, AGENT_MESSAGE_MAX);
      }
      break;
    case "SessionEnd":
    case "SubagentStop":
      return "unbind";
    default:
      return undefined;
  }
  if (state === "") return undefined;
  // What it waits on is the newest prompt still open, for as long as
  // the waiting lasts.
  const newest = nextWaits.at(-1);
  const asks =
    state === "waiting" && newest !== undefined
      ? waitAsk(newest)
      : { tool: "", need: "" };
  if (
    state === session.state &&
    sameList(nextWaits, waits) &&
    title === (session.title ?? "") &&
    asks.tool === (session.tool ?? "") &&
    asks.need === (session.need ?? "") &&
    message === (session.message ?? "")
  ) {
    return undefined;
  }
  return agentSession({
    harness: session.harness,
    session: session.session,
    state,
    at: state === session.state ? session.at : now,
    waits: nextWaits,
    title,
    tool: asks.tool,
    need: asks.need,
    message,
  });
}

// A session with its empty fields left out, as `sm --json` writes it.
export function agentSession(fields: {
  readonly harness: string;
  readonly session: string;
  readonly state: AgentState;
  readonly at: number;
  readonly waits?: ReadonlyArray<string> | undefined;
  readonly title?: string | undefined;
  readonly tool?: string | undefined;
  readonly need?: string | undefined;
  readonly message?: string | undefined;
}): AgentSession {
  const { harness, session, state, at, waits, title, tool, need, message } =
    fields;
  return {
    harness,
    session,
    state,
    at,
    ...(waits !== undefined && waits.length > 0 ? { waits } : {}),
    ...(title ? { title } : {}),
    ...(tool ? { tool } : {}),
    ...(need ? { need } : {}),
    ...(message ? { message } : {}),
  };
}

// The id a session's line shows: its first eight characters.
export const shortSession = (session: string) => session.slice(0, 8);
