// The pure pieces of the doctor's checks: the parsers for what git, ps
// and port-pool print, and the reading of a script's or a launcher's
// command line.
import * as Option from "effect/Option";
import { shellQuote } from "@shigomori/contracts/lifecycleScripts";
import { parseLstart } from "./processes.ts";

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
const GIT_FLOOR = { major: 2, minor: 40 } as const;

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
  /[ \t'"$`\\]/.test(text) ? shellQuote(text) : text;

// "  1234 Sat Oct 17 03:21:24 2026": each pid's birth (`PS_BIRTH_ENV`).
export const parseProcessTable = (stdout: string) => {
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const born = parseLstart(match[2] ?? "");
    if (Option.isSome(born)) table.set(Number(match[1]), born.value);
  }
  return table;
};

export const formatSize = (bytes: number) => {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  if (bytes >= 2 ** 20) return `${Math.floor(bytes / 2 ** 20)} MB`;
  if (bytes >= 2 ** 10) return `${Math.floor(bytes / 2 ** 10)} KB`;
  return `${bytes} bytes`;
};
