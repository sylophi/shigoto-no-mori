// Wrappers over the commands a workflow runs (git, cp, rmdir), put first
// on a PATH, that hold the workflow at one step: before or after the
// command whose arguments hold `match`, they write their pid to `mark` and
// sleep, then go on, so a test can kill or interrupt the process right there. git's move can be
// made to refuse as it does across volumes (`crossVolume`), which takes
// the copy path on one disk. The stop is written beside the wrappers,
// since the engine hands a command only part of its environment.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Stop = {
  readonly tool: "git" | "cp" | "rmdir";
  readonly when: "before" | "after";
  readonly match: string;
};

const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const real = (tool: string) =>
  execFileSync("/usr/bin/which", [tool], { encoding: "utf8" }).trim();

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
  mkdirSync(dir, { recursive: true });
  for (const tool of ["git", "cp", "rmdir"] as const) {
    const refuse =
      tool === "git"
        ? `if [ -n "$STOP_CROSS_VOLUME" ] && [[ "$args" == *"worktree move"* ]]; then
  echo "fatal: failed to move: Invalid cross-device link" >&2
  exit 128
fi
`
        : "";
    writeFileSync(
      join(dir, tool),
      `#!/bin/bash
source "${join(dir, "stop.env")}"
args="$*"
hold() {
  if [ "$STOP_TOOL" = "${tool}" ] && [ "$STOP_WHEN" = "$1" ] && [[ "$args" == *"$STOP_MATCH"* ]]; then
    echo $$ > "$STOP_MARK"
    /bin/sleep "$STOP_SECONDS"
  fi
}
${refuse}hold before
"${real(tool)}" "$@"
code=$?
[ $code -eq 0 ] && hold after
exit $code
`,
    );
    chmodSync(join(dir, tool), 0o755);
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
  return { PATH: `${dir}:${process.env["PATH"] ?? ""}` };
}
