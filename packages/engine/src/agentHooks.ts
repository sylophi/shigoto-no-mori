// The hook entries that run `sm agents event` in each harness's own
// hooks file. Edits leave everything else in the file as it was (key
// order and the spelling of each value included), and an entry is
// recognizably ours by its command: this binary's name running `agents
// event --harness <id>`, so a dev build (smd) and the installed sm keep
// their own entries side by side.
//
// Codex runs a hook only once the user has trusted it (its /hooks
// review), keyed by a hash of the entry, which codexHookHash computes.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { canonicalJson } from "./agentSessions.ts";
import { shellQuote } from "./Lifecycle.ts";

// One hook entry: the event, an optional matcher, and whether it runs
// in the background. PostToolUse fires on every tool, so it never holds
// the agent up.
export type HookSpec = {
  readonly event: string;
  readonly matcher?: string;
  readonly async?: boolean;
};

// The harnesses `sm agents` knows: the env var their shells carry the
// session id in (the same id their hooks receive as session_id), the
// command that resumes a session, and their hooks file.
export type Harness = {
  readonly id: string;
  readonly label: string;
  readonly sessionEnv: string;
  // Whether its subagents' events name the subagent by agent_id, the
  // thread id the subagent's own shell binds under (Codex). A Claude
  // Code subagent works within its parent's session.
  readonly subagentIds: boolean;
  readonly resume: string;
  // The harness's config dir: `dirEnv`, else `dirName` under home. It
  // existing is what "detected" means.
  readonly dirEnv: string;
  readonly dirName: string;
  readonly file: string;
  // Whether the harness wants each hook trusted first (Codex).
  readonly trust: boolean;
  // Whether the file holds nothing but hooks, so one left empty goes.
  readonly ownsFile: boolean;
  readonly hooks: ReadonlyArray<HookSpec>;
};

export const HARNESSES: ReadonlyArray<Harness> = [
  {
    id: "claude",
    label: "Claude Code",
    sessionEnv: "CLAUDE_CODE_SESSION_ID",
    subagentIds: false,
    resume: "claude --resume",
    dirEnv: "CLAUDE_CONFIG_DIR",
    dirName: ".claude",
    file: "settings.json",
    trust: false,
    ownsFile: false,
    hooks: [
      { event: "UserPromptSubmit" },
      { event: "PermissionRequest" },
      { event: "PostToolUse", async: true },
      { event: "PostToolUseFailure", async: true },
      { event: "Notification", matcher: "idle_prompt" },
      { event: "Stop" },
      { event: "StopFailure" },
      { event: "SessionEnd" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    sessionEnv: "CODEX_THREAD_ID",
    subagentIds: true,
    resume: "codex resume",
    dirEnv: "CODEX_HOME",
    dirName: ".codex",
    file: "hooks.json",
    trust: true,
    ownsFile: true,
    hooks: [
      { event: "UserPromptSubmit" },
      { event: "PermissionRequest" },
      { event: "PostToolUse", async: true },
      { event: "Stop" },
      { event: "Interrupt" },
      { event: "SubagentStop" },
      { event: "SessionEnd" },
    ],
  },
];

export const harnessById = (id: string) =>
  HARNESSES.find((harness) => harness.id === id);

// Every hook gets this many seconds. Codex caps SessionEnd and Interrupt
// at 3, and the event itself takes milliseconds.
const HOOK_TIMEOUT = 3;

// `|| true`: a hook's exit code is an instruction to its harness (2
// blocks the prompt, or keeps the turn going), and sm failing before
// `agents event` runs (a data dir it can't open, an older build that
// lacks the command) must never be one.
export const hookCommand = (harness: Harness, binary: string) =>
  `${shellQuote(binary)} agents event --harness ${harness.id} || true`;

// Whether a hook command is one of ours for this harness, whatever path
// it names the binary by.
export function isOurCommand(
  harness: Harness,
  binaryName: string,
  command: string,
): boolean {
  let bin = command;
  let rest = "";
  if (command.startsWith("'")) {
    const end = command.indexOf("'", 1);
    if (end >= 0) {
      bin = command.slice(1, end);
      rest = command.slice(end + 1);
    }
  } else {
    const space = command.indexOf(" ");
    if (space >= 0) {
      bin = command.slice(0, space);
      rest = command.slice(space);
    }
  }
  rest = rest.trim().replace(/ \|\| true$/, "");
  return (
    basename(bin) === binaryName &&
    rest === `agents event --harness ${harness.id}`
  );
}

// The one hook entry a spec installs, its keys as Go's encoder sorts
// them.
const hookHandler = (spec: HookSpec, command: string) =>
  spec.async === true
    ? { async: true, command, timeout: HOOK_TIMEOUT, type: "command" }
    : { command, timeout: HOOK_TIMEOUT, type: "command" };

// --- JSON objects that keep their key order and their values' text ---

type JsonObject = Array<[key: string, raw: string]>;

// Where the JSON value (or key) starting at `start` ends, in text
// JSON.parse has already accepted.
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    let i = start + 1;
    for (; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === "\\") i++;
    }
    return i + 1;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        i = valueEnd(text, i) - 1;
      } else if (c === "{" || c === "[") {
        depth++;
      } else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && !/[\s,:}\]]/.test(text[i] ?? "")) i++;
  return i;
}

const skipSpace = (text: string, i: number) => {
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
};

// The items of a JSON object or array, each as its text: a key and its
// value's text for an object, the item's text for an array.
function members(text: string): Array<[key: string, raw: string]> {
  const object = text.startsWith("{");
  const close = object ? "}" : "]";
  const found: Array<[string, string]> = [];
  let i = skipSpace(text, 1);
  while (i < text.length && text[i] !== close) {
    let key = "";
    if (object) {
      const keyEnd = valueEnd(text, i);
      key = JSON.parse(text.slice(i, keyEnd)) as string;
      i = skipSpace(text, skipSpace(text, keyEnd) + 1);
    }
    const end = valueEnd(text, i);
    found.push([key, text.slice(i, end)]);
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
  }
  return found;
}

// A JSON object's entries, each value as its text, a key given twice
// keeping its first place and its last value. Empty input is an empty
// object. Throws on anything that isn't an object.
function parseObject(raw: string | undefined): JsonObject {
  if (raw === undefined || raw.trim() === "") return [];
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("not a JSON object");
  }
  const entries: JsonObject = [];
  for (const [key, text] of members(raw.trim())) set(entries, key, text);
  return entries;
}

// A JSON array's items, each as its text.
const splitArray = (raw: string) => members(raw.trim()).map(([, text]) => text);

const get = (object: JsonObject, key: string) =>
  object.find(([name]) => name === key)?.[1];

function set(object: JsonObject, key: string, raw: string) {
  const entry = object.find(([name]) => name === key);
  if (entry === undefined) object.push([key, raw]);
  else entry[1] = raw;
}

function del(object: JsonObject, key: string) {
  const index = object.findIndex(([name]) => name === key);
  if (index >= 0) object.splice(index, 1);
}

const stringify = (object: JsonObject) =>
  `{${object.map(([key, raw]) => `${JSON.stringify(key)}:${raw}`).join(",")}}`;

// JSON text re-spaced the way Go's json.Indent writes it with two
// spaces, every value's own text kept.
function indent(raw: string): string {
  let out = "";
  let level = 0;
  const newline = () => `\n${"  ".repeat(level)}`;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] ?? "";
    if (c === '"') {
      let end = i + 1;
      for (; end < raw.length && raw[end] !== '"'; end++) {
        if (raw[end] === "\\") end++;
      }
      out += raw.slice(i, end + 1);
      i = end;
    } else if (/\s/.test(c)) {
      continue;
    } else if (c === "{" || c === "[") {
      const next = raw[skipSpace(raw, i + 1)];
      if (next === "}" || next === "]") {
        out += c + next;
        i = skipSpace(raw, i + 1);
        continue;
      }
      level++;
      out += c + newline();
    } else if (c === "}" || c === "]") {
      level--;
      out += newline() + c;
    } else if (c === ",") {
      out += `,${newline()}`;
    } else if (c === ":") {
      out += ": ";
    } else {
      out += c;
    }
  }
  return out;
}

// --- the hooks file ---

// The file isn't what a hooks file has to be: a JSON object whose
// "hooks" is an object of lists. Fixing it is the user's call.
export class MalformedHooksFile extends Error {
  readonly path: string;
  readonly problem: string;

  constructor(path: string, problem: string) {
    super(`${path} ${problem}. Fix it, then retry.`);
    this.path = path;
    this.problem = problem;
  }
}

// A hooks file: its top-level object, and its "hooks" object's groups
// per event, in order.
export type HooksDoc = {
  readonly top: JsonObject;
  readonly hooks: JsonObject;
};

const problemOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function readHooksDoc(path: string, raw: string): HooksDoc {
  let top: JsonObject;
  try {
    top = parseObject(raw);
  } catch (error) {
    throw new MalformedHooksFile(
      path,
      `isn't a JSON object (${problemOf(error)})`,
    );
  }
  let hooks: JsonObject;
  try {
    hooks = parseObject(get(top, "hooks"));
  } catch (error) {
    throw new MalformedHooksFile(
      path,
      `holds a malformed "hooks" value (${problemOf(error)})`,
    );
  }
  // Each event holds a list of groups. Anything else would be lost when
  // an install rewrites the event.
  for (const [event, value] of hooks) {
    if (!Array.isArray(JSON.parse(value))) {
      throw new MalformedHooksFile(
        path,
        `holds a malformed ${JSON.stringify(event)} hook list (not a list)`,
      );
    }
  }
  return { top, hooks };
}

// An event's groups, each as its text.
const groupsOf = (doc: HooksDoc, event: string) => {
  const raw = get(doc.hooks, event);
  return raw === undefined ? [] : splitArray(raw);
};

type Handler = { readonly command?: unknown };

const handlersOf = (group: unknown): ReadonlyArray<unknown> | undefined =>
  typeof group === "object" &&
  group !== null &&
  "hooks" in group &&
  Array.isArray(group.hooks)
    ? group.hooks
    : undefined;

const commandOf = (handler: unknown) =>
  typeof handler === "object" &&
  handler !== null &&
  typeof (handler as Handler).command === "string"
    ? ((handler as Handler).command as string)
    : "";

// Drops every handler of ours, then any group and event left empty.
// Reports whether there was any.
export function removeOurs(
  doc: HooksDoc,
  ours: (command: string) => boolean,
): boolean {
  let removed = false;
  for (const event of doc.hooks.map(([name]) => name)) {
    const kept: Array<string> = [];
    let changed = false;
    for (const raw of groupsOf(doc, event)) {
      const parsed: unknown = JSON.parse(raw);
      const handlersRaw =
        handlersOf(parsed) === undefined
          ? undefined
          : get(parseObject(raw), "hooks");
      if (handlersRaw === undefined) {
        kept.push(raw);
        continue;
      }
      const handlers = splitArray(handlersRaw);
      const keptHandlers = handlers.filter(
        (handler) => !ours(commandOf(JSON.parse(handler))),
      );
      if (keptHandlers.length === handlers.length) {
        kept.push(raw);
        continue;
      }
      changed = true;
      if (keptHandlers.length > 0) {
        const group = parseObject(raw);
        set(group, "hooks", `[${keptHandlers.join(",")}]`);
        kept.push(stringify(group));
      }
    }
    removed ||= changed;
    if (!changed) continue;
    if (kept.length === 0) del(doc.hooks, event);
    else set(doc.hooks, event, `[${kept.join(",")}]`);
  }
  return removed;
}

export function addOurs(
  doc: HooksDoc,
  harness: Harness,
  command: string,
): void {
  for (const spec of harness.hooks) {
    const group = JSON.stringify({
      ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
      hooks: [hookHandler(spec, command)],
    });
    set(
      doc.hooks,
      spec.event,
      `[${[...groupsOf(doc, spec.event), group].join(",")}]`,
    );
  }
}

// The file's text once the edits are in, and whether nothing is left
// in it.
export function hooksDocText(doc: HooksDoc): {
  readonly text: string;
  readonly empty: boolean;
} {
  if (doc.hooks.length === 0) del(doc.top, "hooks");
  else set(doc.top, "hooks", stringify(doc.hooks));
  return {
    text: `${indent(stringify(doc.top))}\n`,
    empty: doc.top.length === 0,
  };
}

// Where each of our entries sits (event to group index) for the ones
// that match the spec exactly, and how many of ours there are at all.
export function ourEntries(
  doc: HooksDoc,
  harness: Harness,
  command: string,
  ours: (command: string) => boolean,
): { readonly exact: ReadonlyMap<string, number>; readonly total: number } {
  const exact = new Map<string, number>();
  let total = 0;
  for (const [event] of doc.hooks) {
    const spec = harness.hooks.find((wanted) => wanted.event === event);
    groupsOf(doc, event).forEach((raw, index) => {
      const group: unknown = JSON.parse(raw);
      const handlers = handlersOf(group) ?? [];
      const matcher =
        typeof group === "object" && group !== null && "matcher" in group
          ? group.matcher
          : undefined;
      for (const handler of handlers) {
        if (!ours(commandOf(handler))) continue;
        total++;
        if (
          spec === undefined ||
          handlers.length !== 1 ||
          (matcher ?? "") !== (spec.matcher ?? "")
        ) {
          continue;
        }
        if (
          canonicalJson(handler) === canonicalJson(hookHandler(spec, command))
        ) {
          exact.set(event, index);
        }
      }
    });
  }
  return { exact, total };
}

// --- Codex hook trust ---

export function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter, index: number) =>
    index > 0 ? `_${letter.toLowerCase()}` : letter.toLowerCase(),
  );
}

// Codex's trust hash for one hook (codex-rs hooks discovery, hook_hash
// over config fingerprint's version_for_toml): sha256 of the normalized
// entry as compact JSON with sorted keys. The normalized handler always
// carries its timeout and async, and drops unset optionals.
export function codexHookHash(spec: HookSpec, command: string): string {
  const handler = { ...hookHandler(spec, command), async: spec.async === true };
  const identity = {
    event_name: snakeCase(spec.event),
    hooks: [handler],
    ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

const TOML_TABLE = /^\s*\[\s*hooks\.state\."((?:[^"\\]|\\.)*)"\s*\]\s*$/;
const TOML_TRUSTED = /^\s*trusted_hash\s*=\s*"([^"]*)"/;

// The trusted hashes in Codex's config.toml, by hook key ("<hooks
// file>:<event>:<group>:<handler>"). Only the table form Codex writes
// is read.
export function codexTrustedHashes(toml: string): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  let table = "";
  for (const line of toml.split("\n")) {
    const header = TOML_TABLE.exec(line);
    if (header !== null) {
      table = (header[1] ?? "").replaceAll("\\\\", "\\");
      continue;
    }
    if (line.trim().startsWith("[")) {
      table = "";
      continue;
    }
    const trusted = TOML_TRUSTED.exec(line);
    if (trusted !== null && table !== "") hashes.set(table, trusted[1] ?? "");
  }
  return hashes;
}
