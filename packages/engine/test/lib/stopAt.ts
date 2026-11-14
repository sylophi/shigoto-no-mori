// Wrappers over the commands a workflow runs (git, cp, rmdir), put first
// on a PATH, that hold the workflow at one step: before or after the
// command whose arguments hold `match`, they write their pid to `mark` and
// sleep, then go on, so a test can kill or interrupt the process right there. git's move can be
// made to refuse as it does across volumes (`crossVolume`), which takes
// the copy path on one disk. The stop is written beside the wrappers,
// since the engine hands a command only part of its environment.
//
// Windows copies a tree and removes a folder in the engine's own process
// (entries.ts), with no cp or rmdir to wrap. There `holdingFs` holds the
// same steps in node:fs/promises, which a test file mocks with it: after
// a file is copied to a path holding `match`, or before the folder at
// one is removed, it writes this process's pid to `mark` and sleeps.
import { mkdirSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { delimiter, join } from "node:path";
import { SCRIPT_PID } from "../../../../test/testProcesses.mts";
import { realTool, writeStub } from "./stubs.ts";

export type Stop = {
  readonly tool: "git" | "cp" | "rmdir";
  readonly when: "before" | "after";
  readonly match: string;
};

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// How git words EXDEV: Git for Windows in the C runtime's words.
const CROSS_DEVICE =
  process.platform === "win32" ? "Improper link" : "Invalid cross-device link";

// The stop the last stopWrappers armed, for holdingFs.
let armed:
  | { readonly stop?: Stop; readonly mark: string; readonly seconds: number }
  | undefined;

// The wrappers in `dir`, and the environment that arms them: a stop at
// `stop` (none runs every command as itself), held for `seconds`.
export function stopWrappers(
  dir: string,
  options: {
    readonly stop?: Stop;
    readonly mark: string;
    readonly seconds: number;
    readonly crossVolume?: boolean;
  },
): NodeJS.ProcessEnv {
  armed = options;
  mkdirSync(dir, { recursive: true });
  for (const tool of ["git", "cp", "rmdir"] as const) {
    const refuse =
      tool === "git"
        ? `if [ -n "$STOP_CROSS_VOLUME" ] && [[ "$args" == *"worktree move"* ]]; then
  echo "fatal: failed to move: ${CROSS_DEVICE}" >&2
  exit 128
fi
`
        : "";
    writeStub(
      dir,
      tool,
      `#!/bin/bash
source "${join(dir, "stop.env")}"
args="$*"
hold() {
  if [ "$STOP_TOOL" = "${tool}" ] && [ "$STOP_WHEN" = "$1" ] && [[ "$args" == *"$STOP_MATCH"* ]]; then
    echo ${SCRIPT_PID} > "$STOP_MARK"
    /bin/sleep "$STOP_SECONDS"
  fi
}
${refuse}hold before
"${realTool(tool)}" "$@"
code=$?
[ $code -eq 0 ] && hold after
exit $code
`,
    );
  }
  writeFileSync(
    join(dir, "stop.env"),
    Object.entries({
      STOP_TOOL: options.stop?.tool ?? "",
      STOP_WHEN: options.stop?.when ?? "",
      STOP_MATCH: options.stop?.match ?? "",
      STOP_MARK: options.mark,
      STOP_SECONDS: String(options.seconds),
      STOP_CROSS_VOLUME: options.crossVolume === true ? "1" : "",
    })
      .map(([key, value]) => `${key}=${quoted(value)}\n`)
      .join(""),
  );
  return { PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}` };
}

// node:fs/promises with the armed stop's cp and rmdir steps held.
export const holdingFs = (real: typeof FsPromises): typeof FsPromises => {
  const hold = async (
    tool: Stop["tool"],
    when: Stop["when"],
    path: unknown,
  ) => {
    const stop = armed?.stop;
    if (
      armed === undefined ||
      stop?.tool !== tool ||
      stop.when !== when ||
      !String(path).replaceAll("\\", "/").includes(stop.match)
    ) {
      return;
    }
    writeFileSync(armed.mark, String(process.pid));
    const ms = armed.seconds * 1000;
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
  return {
    ...real,
    copyFile: async (from, to, mode) => {
      await real.copyFile(from, to, mode);
      await hold("cp", "after", to);
    },
    rmdir: async (path, options) => {
      await hold("rmdir", "before", path);
      await real.rmdir(path, options);
    },
  };
};
