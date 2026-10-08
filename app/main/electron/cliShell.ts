// Shell-integration management, delegated to the bundled CLI
// (`sm shell status/install/uninstall`): the CLI owns the rc-file
// mechanics and the supported-shell list, so the app and a terminal
// can never disagree about what the hook looks like, what counts as
// ours, or which shells qualify. The app only contributes the login
// shell's name. Each CLI command emits the resulting status document,
// so every operation here is a single spawn.
//
// The login shell is resolved here rather than by the CLI because a
// Finder-launched app inherits launchd's environment, where $SHELL is
// unreliable, so os.userInfo() reads the user database instead.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  ShellHookState,
  ShellIntegrationStatus,
} from "@shigomori/contracts/modules/cli";
import { ShellHookStateSchema } from "@shigomori/contracts/modules/cli";
import { CAPTURE_TIMEOUT_MS, loginShell } from "../core/shellEnv";
import { cliFailureMessage, runCli } from "./cliRunner";
import { envSetting } from "@shared/config";

const execFileP = promisify(execFile);

const decodeShellHookStates = Schema.decodeUnknownOption(
  Schema.Array(ShellHookStateSchema),
);

// The CLI resolves rc locations from ZDOTDIR / XDG_CONFIG_HOME, which
// a Finder-launched app doesn't have (launchd sources no shell
// profile). Without them the hook could land in a file the user's
// shell never reads while Settings reports success. Capture them from
// the user's login shell once and overlay them onto every
// shell-subcommand spawn, so the app targets the same file a
// terminal-run `sm shell install` would. Its own probe rather than the
// startup rebuild's (main/core/shellEnv.ts): that one sees exports
// only, and a ZDOTDIR a .zshenv sets without exporting still names
// the rc file.
const SENTINEL = "__SHIGOMORI_HOOK_ENV__";
let hookEnvPromise: Promise<Record<string, string>> | null = null;

async function captureHookPathEnv(): Promise<Record<string, string>> {
  const shell = loginShell({ SHELL: envSetting("SHELL") });
  if (shell === null) return {};
  try {
    const { stdout } = await execFileP(
      shell,
      [
        "-ilc",
        `printf '%s%s\x1f%s' '${SENTINEL}' "$ZDOTDIR" "$XDG_CONFIG_HOME"`,
      ],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const idx = stdout.lastIndexOf(SENTINEL);
    if (idx < 0) return {};
    const [zdotdir = "", xdgConfigHome = ""] = stdout
      .slice(idx + SENTINEL.length)
      .split("\x1f");
    // Empty values still overlay: they neutralize a stale var in the
    // app's own environment the same way an unset one would.
    return { ZDOTDIR: zdotdir, XDG_CONFIG_HOME: xdgConfigHome };
  } catch {
    return {};
  }
}

// Exported for doctor, whose shell-hook check reads the same rc files.
export function hookPathEnv(): Promise<Record<string, string>> {
  return (hookEnvPromise ??= captureHookPathEnv());
}

function runShellCli(
  args: string[],
): Promise<Awaited<ReturnType<typeof runCli>>> {
  return hookPathEnv().then((env) => runCli(args, undefined, env));
}

function loginShellBase(): string | null {
  const base =
    loginShell({ SHELL: envSetting("SHELL") })
      ?.split("/")
      .pop() ?? "";
  return base === "" ? null : base;
}

// The `shells` array of the CLI's status document, which install and
// uninstall also emit. Empty when the run produced none.
function shellsFromDocs(
  docs: { [key: string]: unknown }[],
): readonly ShellHookState[] {
  const doc = docs.find((d) => d["ok"] === true && d["shells"] !== undefined);
  if (doc === undefined) return [];
  return Option.getOrElse(decodeShellHookStates(doc["shells"]), () => []);
}

// `shells` enumerates exactly the kinds the CLI supports, so the login
// shell is "supported" iff it appears there.
function statusFrom(shells: readonly ShellHookState[]): ShellIntegrationStatus {
  const base = loginShellBase();
  const supported =
    base !== null && shells.some((s) => s.shell === base) ? base : null;
  return { loginShell: supported, shells };
}

// The status a shell subcommand answers with, or the failure it names.
async function statusAfter(
  args: string[],
  fallback: string,
): Promise<ShellIntegrationStatus> {
  const result = await runShellCli(args);
  const shells = shellsFromDocs(result.docs);
  if (result.code !== 0 || shells.length === 0) {
    throw new Error(cliFailureMessage(result, fallback));
  }
  return statusFrom(shells);
}

export function shellIntegrationStatus(): Promise<ShellIntegrationStatus> {
  return statusAfter(
    ["shell", "status"],
    "Couldn't read the shell integration state",
  );
}

// The CLI validates the shell name, and an unsupported one surfaces its
// error message. (Settings never gets here for one: the status it
// renders already reported loginShell null.)
export async function installShellIntegration(): Promise<ShellIntegrationStatus> {
  const base = loginShellBase();
  if (base === null) {
    throw new Error("Couldn't determine your login shell.");
  }
  return statusAfter(
    ["shell", "install", base],
    "Couldn't install shell integration",
  );
}

// Sweeps every supported shell. A partial removal (an edited block the
// CLI refuses to touch) is not a failure: the CLI still emits the
// resulting state, and the returned status shows the leftover as
// "modified" for the UI to explain.
export async function uninstallShellIntegration(): Promise<ShellIntegrationStatus> {
  const result = await runShellCli(["shell", "uninstall"]);
  const shells = shellsFromDocs(result.docs);
  // Exit 1 with a hook still "installed" means removal genuinely
  // failed (unwritable rc), so surface it. Exit 1 with only
  // "modified"/"missing" is the deliberate partial case above.
  if (
    shells.length === 0 ||
    (result.code !== 0 && shells.some((s) => s.state === "installed"))
  ) {
    throw new Error(
      cliFailureMessage(result, "Couldn't remove shell integration"),
    );
  }
  return statusFrom(shells);
}
