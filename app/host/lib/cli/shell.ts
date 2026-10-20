// Shell-integration management, on the engine's ShellIntegration, which
// `sm shell status/install/uninstall` share: one owner of the rc-file
// mechanics and the supported-shell list, so the app and a terminal
// can never disagree about what the hook looks like, what counts as
// ours, or which shells qualify. The app contributes where the login
// shell's config lives.
import type { ShellIntegrationStatus } from "@shigomori/contracts/modules/cli";
import { outputUntil } from "@shared/shellEnv";
import * as Ops from "@host/lib/engineOps";
import * as Lifecycle from "@shigomori/engine/Lifecycle";
import * as ShellIntegration from "@shigomori/engine/ShellIntegration";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { keptAnswers } from "../util/kept";

// The engine resolves rc locations from ZDOTDIR / XDG_CONFIG_HOME, which
// a Finder-launched app doesn't have (launchd sources no shell
// profile). Without them the hook could land in a file the user's
// shell never reads while Settings reports success. Read from the login
// shell, as an interactive one sets them, so the app targets the same
// file a terminal-run `sm shell install` would. Its own probe rather
// than the startup rebuild's (shared/shellEnv.ts): that one sees exports
// only, and a ZDOTDIR a .zshenv sets without exporting still names the
// rc file.
const SENTINEL = "__SHIGOMORI_HOOK_ENV__";
const END = "__SHIGOMORI_HOOK_ENV_END__";
// Asked while Settings waits, and asked again after a failure.
const PROBE_TIMEOUT_MS = 5000;

// What the probe printed between its sentinels: ZDOTDIR, then
// XDG_CONFIG_HOME. Empty values still count: they neutralize a stale
// variable in the app's own environment the same way an unset one
// would.
const hookPlaceOf = (output: string) => {
  const end = output.lastIndexOf(END);
  const at = end < 0 ? -1 : output.lastIndexOf(SENTINEL, end);
  if (at < 0) return Option.none();
  const [zdotdir = "", configHome = ""] = output
    .slice(at + SENTINEL.length, end)
    .split("\x1f");
  return Option.some({ zdotdir, configHome });
};

// The login shell as the engine's shell integration needs it: which
// shell it is and where its config lives. A probe that answered is kept
// an hour (a profile edit moves it), one that didn't is asked again;
// until one answers, the shell's config is looked for where it goes by
// default.
export class HookShell extends Context.Service<
  HookShell,
  { readonly read: Effect.Effect<ShellIntegration.HookShell> }
>()("sm/host/HookShell") {}

export const layer = Layer.effect(
  HookShell,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lifecycle = yield* Lifecycle.Lifecycle;
    // Read up to END, then the shell's exit, which a job its startup
    // files left holding stdout doesn't hold. Past the budget its scope
    // ends it.
    const probes = yield* keptAnswers(
      (shell: string) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              shell,
              [
                "-ilc",
                `printf '%s%s\x1f%s%s' '${SENTINEL}' "$ZDOTDIR" "$XDG_CONFIG_HOME" '${END}'`,
              ],
              { stdin: "ignore", stderr: "ignore" },
            ),
          );
          const output = yield* outputUntil(handle, END);
          const code = yield* handle.exitCode;
          // A shell that failed, its logout files included, answered
          // nothing to keep.
          return yield* Effect.fromOption(
            code === 0 ? Option.flatMap(output, hookPlaceOf) : Option.none(),
          );
        }).pipe(Effect.scoped, Effect.timeout(PROBE_TIMEOUT_MS)),
      Duration.hours(1),
    );
    return HookShell.of({
      read: Effect.gen(function* () {
        const { shell, args } = yield* lifecycle.loginShell;
        // /bin/sh, when no login shell is named: none to integrate with.
        if (args.length === 0) return { zdotdir: "", loginShell: "" };
        const place = yield* probes.get(shell).pipe(Effect.option);
        return Option.match(place, {
          onNone: () => ({ zdotdir: "", loginShell: shell }),
          onSome: (found) => ({ ...found, loginShell: shell }),
        });
      }),
    });
  }),
);

const onShell = <A, E>(
  f: (
    integration: ShellIntegration.ShellIntegration["Service"],
    shell: ShellIntegration.HookShell,
  ) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(
    Effect.flatMap(HookShell, ({ read }) => read),
    (shell) => Ops.onShell(shell, f),
  );

class ShellHookError extends Schema.TaggedError<ShellHookError>()(
  "ShellHookError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// `shells` enumerates exactly the kinds sm supports, so the login
// shell is "supported" iff it appears there.
export const shellIntegrationStatus = onShell((integration, shell) =>
  Effect.map(
    integration.status(shell),
    ({ document }): ShellIntegrationStatus => ({
      loginShell: document.loginShell === "" ? null : document.loginShell,
      shells: document.shells,
    }),
  ),
);

// Settings never asks for an unsupported shell: the status it renders
// already reported loginShell null.
export const installShellIntegration = Effect.gen(function* () {
  const kind = yield* onShell((integration, shell) =>
    integration.loginShell(shell),
  );
  if (kind === "") {
    return yield* new ShellHookError({
      reason: "Couldn't determine your login shell.",
    });
  }
  yield* onShell((integration, shell) => integration.install(kind, shell));
  return yield* shellIntegrationStatus;
});

// Sweeps every supported shell. A partial removal (an edited block
// sm refuses to touch) is not a failure: the returned status shows
// the leftover as "modified" for the UI to explain. A hook that stays
// installed means removal genuinely failed (an unwritable rc), so that
// is surfaced.
export const uninstallShellIntegration = Effect.gen(function* () {
  const results = yield* onShell((integration, shell) =>
    integration.uninstall(shell),
  );
  const status = yield* shellIntegrationStatus;
  const failure = results.find(Result.isFailure);
  if (
    failure !== undefined &&
    status.shells.some((hook) => hook.state === "installed")
  ) {
    return yield* new ShellHookError({ reason: failure.failure.message });
  }
  return status;
});
