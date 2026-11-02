import { cliContract } from "@shigomori/contracts/modules/cli";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { requireCliBinary } from "@host/lib/cli/binary";
import {
  cliLinkStatus,
  installCliLinks,
  uninstallCliEverything,
} from "@host/lib/cli/install";
import {
  HookShell,
  installShellIntegration,
  shellIntegrationStatus,
  uninstallShellIntegration,
} from "@host/lib/cli/shell";
import * as Engine from "@host/lib/Engine";
import * as Scripts from "@host/lib/Scripts";
import * as HostFacts from "@host/lib/HostFacts";
import type { HostServices } from "@host/process/services";
import * as Doctor from "@shigomori/engine/Doctor";
import * as Effect from "effect/Effect";

// A wedged git or gh probe must not leave Settings' health check
// spinning forever. A fix runs the checklist twice (before and after
// the repairs), so it gets twice the budget.
const DOCTOR_TIMEOUT_MS = 60_000;

// The doctor's checklist, told about this install: the app's version,
// the bundled `sm`, and the login shell's ZDOTDIR alone for the
// shell-hook check's .zshrc. XDG_CONFIG_HOME also places the data dir
// pointer, and the doctor must inspect the data dir the app runs on,
// not the one a shell would find. `fix` applies every repair: the
// Repair button's confirm is the consent the terminal asks for per
// repair.
const runDoctor = (fix: boolean) =>
  Effect.gen(function* () {
    const { zdotdir } = yield* (yield* HookShell).read;
    const version = (yield* HostFacts.HostFacts).appVersion;
    const executable = yield* requireCliBinary;
    return yield* (yield* Doctor.Doctor)
      .run({
        version,
        executable,
        zdotdir,
        terminal: false,
        ...(fix
          ? {
              fix: {
                approve: () => Effect.succeed(true),
                failed: () => Effect.void,
              },
            }
          : {}),
      })
      .pipe(Effect.timeout(fix ? 2 * DOCTOR_TIMEOUT_MS : DOCTOR_TIMEOUT_MS));
  });

export const cliHandlers = {
  status: () => cliLinkStatus,
  install: ({ force }) => installCliLinks(force),
  // Only ever removes what shigomori made (links it owns, hooks it
  // wrote), so a foreign occupant survives this unchanged and the
  // returned status says so.
  uninstall: () => Effect.andThen(uninstallCliEverything, cliLinkStatus),
  shellStatus: () => shellIntegrationStatus,
  shellInstall: () => installShellIntegration,
  shellUninstall: () => uninstallShellIntegration,
  doctor: () => runDoctor(false),
  // A repair can unregister a project whose directory is gone, which
  // takes its scripts and terminals, whatever the report says: a repair
  // that failed halfway can still have unregistered.
  doctorFix: () =>
    Engine.changing(runDoctor(true), {}).pipe(
      Effect.ensuring(
        Effect.flatMap(
          Scripts.Scripts,
          (scripts) => scripts.reapRemovedProjects,
        ),
      ),
    ),
} satisfies EffectHandlers<typeof cliContract, unknown, HostServices>;
