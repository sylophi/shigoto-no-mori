import { updaterContract } from "@shigomori/contracts/modules/updater";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import { lastUpdaterState, onShell, shellCalls } from "@host/process/shell";
import * as Effect from "effect/Effect";

// The updater lives in the shell (main/electron/updater.ts), which
// reports its state here as it moves (host/process/session.ts). A
// peer's Settings page reads it and, when granted, checks or restarts
// into an update through the shell.
export const updaterHandlers: EffectHandlers<
  typeof updaterContract,
  HandlerContext
> = {
  get: () => Effect.sync(lastUpdaterState),
  check: () => onShell(() => shellCalls().updater.check()),
  install: (_input, ctx) =>
    onShell(() => shellCalls().updater.install(isRemoteCaller(ctx))),
  update: (_input, ctx) =>
    onShell(() => shellCalls().updater.update(isRemoteCaller(ctx))),
};
