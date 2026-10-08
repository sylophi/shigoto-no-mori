// The pure pieces of the doctor's checks: the parsers for what git, ps
// and port-pool print, the words a finding counts with, the shell hook
// as install writes it, and just enough semver to tell an update file
// this build already is.

export const plural = (n: number) => (n === 1 ? "" : "s");

// English has more irregulars than a trailing "s" covers ("entry is",
// "entries are"), so this one takes both forms.
export const pluralize = (n: number, one: string, many: string) =>
  n === 1 ? one : many;

// Go's strings.Fields: the words between runs of white space.
export const fields = (text: string) =>
  text.split(/\s+/).filter((word) => word !== "");

// Go's strconv.Atoi: an optional sign and digits, nothing else.
export const atoi = (text: string): number | undefined =>
  /^[+-]?\d+$/.test(text) ? Number(text) : undefined;

// Go's strings.Trim with a set of characters, from both ends.
const trimChars = (text: string, chars: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text.charAt(start))) start++;
  while (end > start && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(start, end);
};

// check-attr --source (a clone checkout reads the new commit's
// attributes with it) landed in git 2.40, which makes it the floor.
export const GIT_FLOOR = { major: 2, minor: 40 } as const;

export const belowGitFloor = (major: number, minor: number) =>
  major < GIT_FLOOR.major ||
  (major === GIT_FLOOR.major && minor < GIT_FLOOR.minor);

// The leading major.minor of a git version ("2.39.5", "2.51.0.1",
// "2.39.5 (Apple Git-154)"), none when nothing numeric leads. An
// unparseable minor reads as 0, the conservative answer for a floor.
export const parseGitVersion = (raw: string) => {
  const [first] = fields(raw);
  if (first === undefined) return undefined;
  const [majorText = "", minorText] = first.split(".");
  const major = atoi(majorText);
  if (major === undefined) return undefined;
  return { major, minor: atoi(minorText ?? "") ?? 0 };
};

// `port-pool list` prints "  <port> -> <dir> (<date>)" per allocation.
// An unrecognized line is skipped, so a change in its output degrades
// to "no allocations found" instead of a wrong diagnosis.
export const parsePortPoolDirs = (stdout: string) =>
  stdout.split("\n").flatMap((line) => {
    const arrow = line.indexOf(" -> ");
    if (arrow < 0) return [];
    let dir = line.slice(arrow + " -> ".length).trim();
    const date = dir.lastIndexOf(" (");
    if (date > 0) dir = dir.slice(0, date);
    return dir.startsWith("/") ? [dir] : [];
  });

// The tokens of a lifecycle script that unambiguously name a file in
// the repo: an explicit ./ or a relative path with a slash and no shell
// syntax in it. Each comes with the path it names, relative to the repo.
export const scriptFileTokens = (command: string) =>
  fields(command).flatMap((word) => {
    const token = trimChars(word, `"'`);
    if (token === "" || token.startsWith("-")) return [];
    if (/[$*?`~|&;<>()]/.test(token) || token.includes("://")) return [];
    const relative = token.startsWith("./") ? token.slice(2) : token;
    if (!relative.includes("/") || relative.startsWith("/")) return [];
    return [{ token, relative }];
  });

// Shell words that aren't programs on PATH.
const SHELL_BUILTINS = new Set([
  "cd",
  "exec",
  "command",
  "eval",
  "source",
  ".",
  "export",
  "set",
  "if",
  "for",
  "while",
  "case",
  "test",
  "[",
  "echo",
  "printf",
  "true",
  "false",
  "exit",
  "time",
  "nohup",
  "!",
]);

// The program a launcher command starts, when that can be told without
// a shell: its first word. Empty whenever the command opens with
// anything a shell would interpret first (a variable, an assignment, a
// quoted path with spaces, a builtin, a relative path), so a false alarm
// is never raised.
export const launcherProgram = (
  command: string,
  expandHome: (path: string) => string,
) => {
  let [first] = fields(command);
  if (first === undefined) return "";
  const unquoted = trimChars(first, `"'`);
  if (unquoted !== first) {
    // Quoted and whole (no space inside), or give up.
    if (first.length < 2 || first.charAt(0) !== first.at(-1)) return "";
    first = unquoted;
  }
  first = expandHome(first);
  if (first === "" || SHELL_BUILTINS.has(first)) return "";
  if (/[$`=(){}|&;<>*?\\]/.test(first)) return "";
  // Relative to the worktree it runs in.
  if (first.includes("/") && !first.startsWith("/")) return "";
  return first;
};

// A label as one shell word, for a fix line meant to be pasted.
export const shellWord = (text: string) =>
  /[ \t'"$`\\]/.test(text) ? `'${text.replaceAll("'", `'\\''`)}'` : text;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "  1234 Mon Aug 17 18:42:41 2026": each pid's start time, local.
const PS_LINE =
  /^\s*(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s*$/;

export const parseProcessTable = (stdout: string) => {
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) continue;
    const [, pid, month, day, hours, minutes, seconds, year] = match;
    const monthIndex = MONTHS.indexOf(month ?? "");
    if (monthIndex < 0) continue;
    table.set(
      Number(pid),
      new Date(
        Number(year),
        monthIndex,
        Number(day),
        Number(hours),
        Number(minutes),
        Number(seconds),
      ).getTime(),
    );
  }
  return table;
};

export const formatSize = (bytes: number) => {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  if (bytes >= 2 ** 20) return `${Math.floor(bytes / 2 ** 20)} MB`;
  if (bytes >= 2 ** 10) return `${Math.floor(bytes / 2 ** 10)} KB`;
  return `${bytes} bytes`;
};

// --- semver ---

type Semver = {
  readonly core: readonly [number, number, number];
  readonly pre: ReadonlyArray<string>;
};

const isNumeric = (id: string) => /^\d+$/.test(id);

// Accepts an optional leading "v". Build metadata is dropped, since it
// never takes part in precedence.
export const parseSemver = (raw: string): Semver | undefined => {
  const text = (raw.startsWith("v") ? raw.slice(1) : raw).split("+")[0] ?? "";
  const dash = text.indexOf("-");
  const core = dash < 0 ? text : text.slice(0, dash);
  const parts = core.split(".");
  if (parts.length !== 3) return undefined;
  // No signs and no leading zeros.
  const nums = parts.map((part) =>
    /^(0|[1-9]\d*)$/.test(part) ? Number(part) : undefined,
  );
  const [major, minor, patch] = nums;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  const pre = dash < 0 ? [] : text.slice(dash + 1).split(".");
  for (const id of pre) {
    if (!/^[0-9A-Za-z-]+$/.test(id)) return undefined;
    if (isNumeric(id) && id.length > 1 && id.startsWith("0")) return undefined;
  }
  return { core: [major, minor, patch], pre };
};

const compareNumbers = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Numeric identifiers compare numerically and rank below alphanumeric
// ones, which compare as ASCII.
const compareIdentifier = (a: string, b: string) => {
  const aNumeric = isNumeric(a);
  const bNumeric = isNumeric(b);
  if (aNumeric && bNumeric) {
    return compareNumbers(a.length, b.length) || compareText(a, b);
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return compareText(a, b);
};

const compareSemver = (a: Semver, b: Semver): number => {
  for (let i = 0; i < 3; i++) {
    const order = compareNumbers(a.core[i] ?? 0, b.core[i] ?? 0);
    if (order !== 0) return order;
  }
  // A prerelease ranks below the full release it precedes.
  if (a.pre.length > 0 !== b.pre.length > 0) {
    return a.pre.length > 0 ? -1 : 1;
  }
  for (let i = 0; i < a.pre.length && i < b.pre.length; i++) {
    const order = compareIdentifier(a.pre[i] ?? "", b.pre[i] ?? "");
    if (order !== 0) return order;
  }
  return compareNumbers(a.pre.length, b.pre.length);
};

// Whether `candidate` is a newer version than `current`. False when
// either doesn't parse.
export const newerThan = (candidate: string, current: string) => {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  return a !== undefined && b !== undefined && compareSemver(a, b) > 0;
};

// --- the shell hook ---

export type ShellKind = "zsh" | "bash" | "fish";

export const SHELL_KINDS: ReadonlyArray<ShellKind> = ["zsh", "bash", "fish"];

// What `sm shell install` writes, by the flavor's command and alias.
export type HookNames = { readonly binary: string; readonly alias: string };

export const hookBeginMarker = ({ alias }: HookNames) =>
  `# >>> ${alias} shell integration >>>`;

export const hookEndMarker = ({ alias }: HookNames) =>
  `# <<< ${alias} shell integration <<<`;

// The fenced block in a zsh or bash rc file.
export const hookBlock = (names: HookNames, kind: ShellKind) =>
  `${hookBeginMarker(names)}\ncommand -v ${names.binary} >/dev/null 2>&1 && eval "$(command ${names.binary} shell init ${kind})"\n${hookEndMarker(names)}\n`;

// fish's conf.d drop-in, the whole hook.
export const fishHookContent = (names: HookNames) =>
  `${hookBeginMarker(names)}
# Managed by \`${names.binary} shell install\`. Edits here are overwritten.
if command -q ${names.binary}
    command ${names.binary} shell init fish | source
end
${hookEndMarker(names)}
`;

// A line install would delete: blank, a comment, or one that runs our
// own `shell init` (any guard-line vintage).
const hookLineOurs = (names: HookNames, line: string) => {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    trimmed.includes(`${names.binary} shell init`)
  );
};

// The fenced block in an rc file's lines: where it is and whether its
// content is ours, `broken` for a begin marker with no end.
export type HookSpan =
  | { readonly kind: "none" }
  | { readonly kind: "broken" }
  | {
      readonly kind: "found";
      readonly begin: number;
      readonly end: number;
      readonly ours: boolean;
    };

export const findHookSpan = (
  names: HookNames,
  lines: ReadonlyArray<string>,
): HookSpan => {
  const begin = lines.findIndex(
    (line) => line.trim() === hookBeginMarker(names),
  );
  if (begin < 0) return { kind: "none" };
  for (let end = begin + 1; end < lines.length; end++) {
    if ((lines[end] ?? "").trim() === hookEndMarker(names)) {
      const ours = lines
        .slice(begin + 1, end)
        .every((inner) => hookLineOurs(names, inner));
      return { kind: "found", begin, end, ours };
    }
  }
  return { kind: "broken" };
};
