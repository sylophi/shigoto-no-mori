// A command a test puts on PATH, written as a script with its #! line.
// A Mac and Linux run it as it is. On Windows a shell runs it by name
// too, and Node starts it through a batch file beside it, which hands
// it to Git Bash with its arguments (through node, since Git Bash would
// glob them from cmd's line).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

let sh: string | undefined;
// Git Bash's sh beside the git on PATH, through its launcher, which
// puts Git Bash's own tools on a stub's PATH.
const gitBashSh = () =>
  (sh ??= resolve(
    execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
    "../../../bin/sh.exe",
  ));

// What runs a stub on Windows: the script with the arguments node got,
// set as sh's own on one quoted line, its backslashes doubled as Git
// Bash reads them back.
const launcher = (
  script: string,
) => `import { spawnSync } from "node:child_process";
const quote = (s) => "'" + s.replaceAll("'", "'\\\\''") + "'";
const line = "set -- " + process.argv.slice(2).map(quote).join(" ") + "; exec " + quote(${JSON.stringify(script)}) + ' "$@"';
const ran = spawnSync(${JSON.stringify(gitBashSh())}, ["-c", line.replace(/\\\\+(?=[^"\\\\])/g, "$&$&")], { stdio: "inherit" });
process.exit(ran.status ?? 1);
`;

export const writeStub = (dir: string, name: string, script: string) => {
  writeFileSync(join(dir, name), script, { mode: 0o755 });
  if (process.platform !== "win32") return;
  writeFileSync(join(dir, `${name}.mjs`), launcher(join(dir, name)));
  writeFileSync(
    join(dir, `${name}.cmd`),
    `@"${process.execPath}" "%~dpn0.mjs" %*\r\n`,
  );
};

// Where a real tool is, for a stub to hand on to: as sh finds it.
export const realTool = (tool: string) =>
  process.platform === "win32"
    ? execFileSync(gitBashSh(), ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).trim()
    : execFileSync("/usr/bin/which", [tool], { encoding: "utf8" }).trim();
