// Shell integration, so `cd` moves the calling shell instead of nesting
// a subshell (a child process can never chdir its parent).
//
// `shell init <shell>` prints a wrapper function that shadows the
// command. The wrapper makes a temp directive file, exports its path as
// SHIGOMORI_CD_FILE, runs the real binary, then cd's to the path the
// binary left in the file. The file carries a raw path and is never
// parsed as shell, so nothing sm prints can inject into the caller.
//
// `shell install` adds one guarded eval line to the shell's config: a
// marker-fenced block in the rc file for zsh and bash, a conf.d drop-in
// for fish. The guard keeps the line inert when the binary is gone, and
// the wrapper itself always comes fresh from `shell init`, so an upgrade
// needs no reinstall. `shell uninstall` removes exactly what install
// wrote, and a block whose content isn't recognizably ours is left
// alone. The markers and the drop-in are named for the flavor's alias,
// so the prod and dev builds install side by side.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import { isNotFound } from "./platformErrors.ts";

export type ShellKind = "zsh" | "bash" | "fish";

export const SHELL_KINDS: ReadonlyArray<ShellKind> = ["zsh", "bash", "fish"];

export const isShellKind = (text: string): text is ShellKind =>
  SHELL_KINDS.some((kind) => kind === text);

// What the hook and the wrapper are named for: the flavor's command and
// alias.
export type HookNames = { readonly binary: string; readonly alias: string };

// Set by the wrapper for every invocation. A child sm starts (a script,
// a subshell) never inherits it, or a nested `sm cd` would move the
// user's shell somewhere they never asked for.
export const CD_FILE_ENV = "SHIGOMORI_CD_FILE";

// What `cd` writes to the directive file: a raw path.
export const cdDirective = (target: string) => `${target}\n`;

// --- the wrapper (`shell init`) ---

const wrapperHeader = (names: HookNames, kindNote: string) =>
  `# Shigoto no Mori shell integration (${names.binary} shell init${kindNote}). The wrapper
# hands the real binary a directive file via ${CD_FILE_ENV}. When a
# command wants this shell somewhere (cd, create), it writes the target
# path there and the wrapper cd's. The file carries a raw path, never
# shell code.
`;

// The helper's name is the alias's, so prod and dev wrappers coexist.
const wrapHelper = ({ alias }: HookNames) =>
  `__${alias.replaceAll("-", "_")}_wrap`;

const posixWrapper = (names: HookNames) => {
  const helper = wrapHelper(names);
  return `${wrapperHeader(names, "")}${helper}() {
  local bin="$1" tmp rc dir
  shift
  tmp="$(command mktemp)" || { command "$bin" "$@"; return; }
  ${CD_FILE_ENV}="$tmp" command "$bin" "$@"
  rc=$?
  if [ -s "$tmp" ]; then
    IFS= read -r dir <"$tmp"
    [ -d "$dir" ] && cd -- "$dir"
  fi
  command rm -f -- "$tmp"
  return "$rc"
}
${[names.binary, names.alias]
  .map((name) => `${name}() { ${helper} ${name} "$@"; }\n`)
  .join("")}`;
};

const fishWrapper = (names: HookNames) => {
  const helper = wrapHelper(names);
  return `${wrapperHeader(names, " fish")}function ${helper}
    set -l bin $argv[1]
    set -e argv[1]
    set -l tmp (command mktemp)
    or begin
        command $bin $argv
        return $status
    end
    ${CD_FILE_ENV}=$tmp command $bin $argv
    set -l rc $status
    if test -s $tmp
        set -l dir (command head -n 1 -- $tmp)
        if test -d "$dir"
            cd -- $dir
        end
    end
    command rm -f -- $tmp
    return $rc
end
${[names.binary, names.alias]
  .map(
    (name) =>
      `function ${name} --wraps ${name}\n    ${helper} ${name} $argv\nend\n`,
  )
  .join("")}`;
};

export const wrapperSnippet = (names: HookNames, kind: ShellKind) =>
  kind === "fish" ? fishWrapper(names) : posixWrapper(names);

// --- the hook in the shell's config ---

const hookBeginMarker = ({ alias }: HookNames) =>
  `# >>> ${alias} shell integration >>>`;

const hookEndMarker = ({ alias }: HookNames) =>
  `# <<< ${alias} shell integration <<<`;

// The fenced block in a zsh or bash rc file. The guard keeps shell
// startup silent when the binary is gone (the app trashed, the link
// removed).
const hookBlock = (names: HookNames, kind: ShellKind) =>
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
// content is ours, `broken` for a begin marker with no end, where we
// won't guess where the user's file resumes.
type HookSpan =
  | { readonly kind: "none" }
  | { readonly kind: "broken" }
  | {
      readonly kind: "found";
      readonly begin: number;
      readonly end: number;
      readonly ours: boolean;
    };

const findHookSpan = (
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

// Where the hook lives and what it's named for.
export type HookPlace = {
  readonly names: HookNames;
  readonly home: string;
  readonly zdotdir: string;
  readonly configHome: string;
};

// The file each shell reads, where install writes the hook.
export const hookPath = (place: HookPlace, kind: ShellKind) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (kind === "zsh") {
      return path.join(
        place.zdotdir === "" ? place.home : place.zdotdir,
        ".zshrc",
      );
    }
    if (kind === "bash") {
      // macOS terminals start bash as a login shell, which never reads
      // .bashrc, so the first login file that exists, never creating
      // one that would shadow another.
      for (const name of [".bash_profile", ".bash_login", ".profile"]) {
        const candidate = path.join(place.home, name);
        const isFile = yield* fs.stat(candidate).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        );
        if (isFile) return candidate;
      }
      return path.join(place.home, ".bash_profile");
    }
    return path.join(
      place.configHome,
      "fish",
      "conf.d",
      `${place.names.alias}.fish`,
    );
  });

// installed: the hook is there and recognizably ours, `current` when it
// is what this build writes. missing: no hook, or no file. modified:
// markers with content we didn't write, or a file that can't be read,
// which install and uninstall leave alone.
export type HookState = "installed" | "missing" | "modified";

export type Hook = {
  readonly shell: ShellKind;
  readonly path: string;
  readonly state: HookState;
  readonly current: boolean;
  // What the file holds, when it could be read.
  readonly text: string | undefined;
  // Why a file that is there couldn't be read.
  readonly unreadable: PlatformError.PlatformError | undefined;
};

export const inspectHook = (place: HookPlace, kind: ShellKind) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* hookPath(place, kind);
    const hook = {
      shell: kind,
      path: target,
      current: false,
      text: undefined,
      unreadable: undefined,
    };
    const read = yield* fs.readFileString(target).pipe(Effect.result);
    if (Result.isFailure(read)) {
      return isNotFound(read.failure)
        ? ({ ...hook, state: "missing" } satisfies Hook)
        : ({
            ...hook,
            state: "modified",
            unreadable: read.failure,
          } satisfies Hook);
    }
    const text = read.success;
    if (kind === "fish") {
      // The drop-in is wholly ours (a namespaced name, an "edits are
      // overwritten" header), so our marker makes it ours, any vintage.
      return text.includes(hookBeginMarker(place.names))
        ? ({
            ...hook,
            state: "installed",
            current: text === fishHookContent(place.names),
            text,
          } satisfies Hook)
        : ({ ...hook, state: "modified", text } satisfies Hook);
    }
    const lines = text.split("\n");
    const span = findHookSpan(place.names, lines);
    if (span.kind === "none") {
      return { ...hook, state: "missing", text } satisfies Hook;
    }
    if (span.kind === "broken" || !span.ours) {
      return { ...hook, state: "modified", text } satisfies Hook;
    }
    return {
      ...hook,
      state: "installed",
      current:
        lines.slice(span.begin, span.end + 1).join("\n") ===
        hookBlock(place.names, kind).replace(/\n+$/, ""),
      text,
    } satisfies Hook;
  });

// The rc file with the hook in it: appended after a blank line, or the
// block refreshed in place, since the guard line may have a new shape.
export const withHook = (
  names: HookNames,
  kind: ShellKind,
  text: string | undefined,
) => {
  const lines = (text ?? "").split("\n");
  const span = findHookSpan(names, lines);
  if (span.kind !== "found") {
    const kept = (text ?? "").replace(/\n+$/, "");
    return `${kept === "" ? "" : `${kept}\n\n`}${hookBlock(names, kind)}`;
  }
  return [
    ...lines.slice(0, span.begin),
    ...hookBlock(names, kind).replace(/\n+$/, "").split("\n"),
    ...lines.slice(span.end + 1),
  ].join("\n");
};

// The rc file without the hook, and the blank line install put before
// it.
export const withoutHook = (names: HookNames, text: string) => {
  const lines = text.split("\n");
  const span = findHookSpan(names, lines);
  if (span.kind !== "found") return text;
  const begin =
    span.begin > 0 && (lines[span.begin - 1] ?? "").trim() === ""
      ? span.begin - 1
      : span.begin;
  return [...lines.slice(0, begin), ...lines.slice(span.end + 1)].join("\n");
};
