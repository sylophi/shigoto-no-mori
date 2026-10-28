// This device's switches on the account page, read and set from a
// terminal (control:access, control:setAccess). Each is kept where the
// page keeps it: sharing in the device settings, the command switch on
// the account's record and keeping it reachable with the app, those two
// by the shell.
import type { controlContract } from "@shigomori/contracts/modules/control";
import type { EffectHandlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import * as Effect from "effect/Effect";
import { HostAccount } from "@host/lib/HostAccount";
import * as Sharing from "@host/lib/Sharing";
import * as Shell from "@host/lib/Shell";
import type { HostServices } from "@host/process/services";
import { signedOut } from "./peers";

type Handler = EffectHandlers<
  typeof controlContract,
  HandlerContext,
  HostServices
>;

export const access: Handler["access"] = () =>
  Effect.gen(function* () {
    const { facts } = yield* Effect.flatMap(HostAccount, (it) => it.current);
    return {
      share: yield* Effect.flatMap(Sharing.Sharing, (it) => it.current),
      control: facts?.acceptsCommands === true,
      keepReachable: yield* Effect.flatMap(
        Shell.Shell,
        (it) => it.keepReachable,
      ),
    };
  });

// The answer is the switches as set: the shell's report of the command
// switch can reach the host after it.
export const setAccess: Handler["setAccess"] = (patch, ctx) =>
  Effect.gen(function* () {
    const { share, control, keepReachable } = patch;
    const shell = yield* Shell.Shell;
    if (control !== undefined) {
      const { facts } = yield* Effect.flatMap(HostAccount, (it) => it.current);
      if (facts === null) return yield* Effect.fail(signedOut());
    }
    if (share !== undefined) {
      yield* Effect.flatMap(Sharing.Sharing, (it) => it.set(share));
    }
    if (control !== undefined) yield* shell.setAcceptsCommands(control);
    if (keepReachable !== undefined) {
      yield* shell.setKeepReachable(keepReachable);
    }
    return { ...(yield* access(undefined, ctx)), ...patch };
  });
