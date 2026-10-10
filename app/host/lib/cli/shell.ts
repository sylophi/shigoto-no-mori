// Shell-integration management, on the engine's ShellIntegration, which
// `sm shell status/install/uninstall` share: one owner of the rc-file
// mechanics and the supported-shell list, so the app and a terminal
// can never disagree about what the hook looks like, what counts as
// ours, or which shells qualify. The app contributes the login shell
// and where its config lives.
//
// The login shell is resolved here rather than by the engine because a
// Finder-launched app inherits launchd's environment, where $SHELL is
// unreliable, so os.userInfo() reads the user database instead.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ShellIntegrationStatus } from "@shigomori/contracts/modules/cli";
import { CAPTURE_TIMEOUT_MS, loginShell } from "@host/lib/util/shellEnv";
import * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";
import * as ShellIntegration from "@shigomori/engine/ShellIntegration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { envSetting } from "@shared/config";

const execFileP = promisify(execFile);

// The CLI resolves rc locations from ZDOTDIR / XDG_CONFIG_HOME, which
// a Finder-launched app doesn't have (launchd sources no shell
// profile). Without them the hook could land in a file the user's
// shell never reads while Settings reports success. Capture them from
// the user's login shell once and overlay them onto every
// shell-subcommand spawn, so the app targets the same file a
// terminal-run `sm shell install` would. Its own probe rather than the
// startup rebuild's (host/lib/util/shellEnv.ts): that one sees exports
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

// The login shell as the engine's shell integration needs it: where
// its config lives, and which shell it is.
async function hookShell(): Promise<ShellIntegration.HookShell> {
  const env = await hookPathEnv();
  return {
    zdotdir: env["ZDOTDIR"] ?? "",
    configHome: env["XDG_CONFIG_HOME"],
    loginShell: loginShell({ SHELL: envSetting("SHELL") }) ?? "",
  };
}

const onShell = <A, E>(
  f: (
    integration: ShellIntegration.ShellIntegration["Service"],
    shell: ShellIntegration.HookShell,
  ) => Effect.Effect<A, E>,
): Promise<A> => hookShell().then((shell) => Engine.run(Ops.onShell(shell, f)));

// `shells` enumerates exactly the kinds sm supports, so the login
// shell is "supported" iff it appears there.
const statusNow = () =>
  onShell((integration, shell) =>
    Effect.map(
      integration.status(shell),
      ({ document }): ShellIntegrationStatus => ({
        loginShell: document.loginShell === "" ? null : document.loginShell,
        shells: document.shells,
      }),
    ),
  );

export function shellIntegrationStatus(): Promise<ShellIntegrationStatus> {
  return statusNow();
}

// Settings never asks for an unsupported shell: the status it renders
// already reported loginShell null.
export async function installShellIntegration(): Promise<ShellIntegrationStatus> {
  const kind = await onShell((integration, shell) =>
    integration.loginShell(shell),
  );
  if (kind === "") throw new Error("Couldn't determine your login shell.");
  await onShell((integration, shell) => integration.install(kind, shell));
  return statusNow();
}

// Sweeps every supported shell. A partial removal (an edited block
// sm refuses to touch) is not a failure: the returned status shows
// the leftover as "modified" for the UI to explain. A hook that stays
// installed means removal genuinely failed (an unwritable rc), so that
// is surfaced.
export async function uninstallShellIntegration(): Promise<ShellIntegrationStatus> {
  const results = await onShell((integration, shell) =>
    integration.uninstall(shell),
  );
  const status = await statusNow();
  const failure = results.find(Result.isFailure);
  if (
    failure !== undefined &&
    status.shells.some((hook) => hook.state === "installed")
  ) {
    throw new Error(failure.failure.message);
  }
  return status;
}
