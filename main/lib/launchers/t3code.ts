// T3 Code (macOS-only here) is the one launcher that can't be handed a
// folder. Its desktop app parses no argv path and registers no inbound
// URL handler -- the `t3code://` scheme it claims serves the renderer
// origin and receives OAuth callbacks, and its protocol handler 404s any
// host but `app`. The only programmatic way in is the `t3` CLI's
// `project add`, which registers a workspace root in T3 Code's project
// list: live over HTTP when the app is running, straight into its store
// when it isn't.
//
// That still yields "opened, ready to go" in the main case. T3 Code's
// window always loads its index route, which auto-opens a draft composer
// for the project with the newest activity -- and a just-added project
// (fresh updatedAt, no threads yet) is exactly that. So add-then-launch
// lands in a prompt for the worktree. Two weaker corners, both inherent
// to T3 Code 0.0.32: if the app is already running there is no external
// navigation channel at all (no command, endpoint, or deep link moves
// its UI), so the project lands at the top of the sidebar and the app is
// focused; and if the project was already registered and the user has
// since worked in another T3 project, that other project's activity is
// newer and the landing draft targets it instead.
//
// The launch invokes the CLI bundled inside the installed app through
// the app's own Electron binary in Node mode, so nothing depends on an
// npm-installed `t3` or version skew against the app.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const T3CODE_ID = "t3code";

// CLI entry point inside an installed app, relative to
// Contents/Resources. Electron's asar-aware fs lets its own binary spawn
// straight into it.
export const T3_BUNDLED_CLI_SUBPATH = [
  "app.asar",
  "apps",
  "server",
  "dist",
  "bin.mjs",
] as const;

// `project add` is not idempotent -- re-adding a registered workspace
// root fails with ProjectAlreadyExistsError. A launcher gets pressed
// repeatedly on the same worktree and "already there" is exactly our
// success case, so swallow that one error and surface every other
// failure. Electron logs a "Node.js environment variables are disabled"
// line to stderr when another app spawns it in Node mode; harmless, the
// script still runs.
export async function addProjectViaBundledCli(
  electronBinary: string,
  cliScript: string,
  worktreePath: string,
): Promise<void> {
  try {
    await exec(electronBinary, [cliScript, "project", "add", worktreePath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: string; stderr?: string };
    if (
      `${stderr ?? ""}${stdout ?? ""}`.includes("ProjectAlreadyExistsError")
    ) {
      return;
    }
    throw err;
  }
}
