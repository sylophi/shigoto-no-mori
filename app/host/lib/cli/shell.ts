// Shell-integration management, on the engine's ShellIntegration, which
// `sm shell status/install/uninstall` share: one owner of the rc-file
// mechanics and the supported-shell list, so the app and a terminal
// can never disagree about what the hook looks like, what counts as
// ours, or which shells qualify. The app contributes where the login
// shell's config lives.
import type { ShellIntegrationStatus } from "@shigomori/contracts/modules/cli";
import { CAPTURE_TIMEOUT_MS } from "@shared/shellEnv";
import * as Ops from "@host/lib/engineOps";
import * as Lifecycle from "@shigomori/engine/Lifecycle";
import { captureWithin } from "@shigomori/engine/processes";
import * as ShellIntegration from "@shigomori/engine/ShellIntegration";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { answersFor } from "../util/cacheTtl";

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

// What the probe printed after its sentinel: ZDOTDIR, then
// XDG_CONFIG_HOME. Empty values still count: they neutralize a stale
// variable in the app's own environment the same way an unset one
// would.
const hookPlaceOf = (output: string) => {
  const at = output.lastIndexOf(SENTINEL);
  if (at < 0) return Option.none();
  const [zdotdir = "", configHome = ""] = output
    .slice(at + SENTINEL.length)
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
    const probes = yield* Cache.makeWith(
      (shell: string) =>
        captureWithin(
          spawner,
          shell,
          [
            "-ilc",
            `printf '%s%s\x1f%s' '${SENTINEL}' "$ZDOTDIR" "$XDG_CONFIG_HOME"`,
          ],
          Duration.millis(CAPTURE_TIMEOUT_MS),
        ).pipe(
          Effect.flatMap(({ output }) =>
            Effect.fromOption(hookPlaceOf(output)),
          ),
        ),
      { capacity: 1, timeToLive: answersFor(Duration.hours(1)) },
    );
    return HookShell.of({
      read: Effect.gen(function* () {
        const { shell, args } = yield* lifecycle.loginShell;
        // /bin/sh, when no login shell is named: none to integrate with.
        if (args.length === 0) return { zdotdir: "", loginShell: "" };
        const place = yield* Cache.get(probes, shell).pipe(Effect.option);
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
