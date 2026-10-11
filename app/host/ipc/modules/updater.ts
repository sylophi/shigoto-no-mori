import { updaterContract } from "@shigomori/contracts/modules/updater";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import * as Shell from "@host/lib/Shell";
import type { HostServices } from "@host/process/services";

// The updater lives in the shell (main/electron/updater.ts), which
// reports its state here as it moves (host/process/session.ts). A
// peer's Settings page reads it and, when granted, checks or restarts
// into an update through the shell.
export const updaterHandlers = {
  get: () => Effect.flatMap(Shell.Shell, (shell) => shell.updater.state),
  check: () => Effect.flatMap(Shell.Shell, (shell) => shell.updater.check),
  install: (_input, ctx) =>
    Effect.flatMap(Shell.Shell, (shell) =>
      shell.updater.install(isRemoteCaller(ctx)),
    ),
  update: (_input, ctx) =>
    Effect.flatMap(Shell.Shell, (shell) =>
      shell.updater.update(isRemoteCaller(ctx)),
    ),
} satisfies EffectHandlers<
  typeof updaterContract,
  HandlerContext,
  HostServices
>;
