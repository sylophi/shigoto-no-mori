import { updaterContract } from "@shigomori/contracts/modules/updater";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { Handlers } from "@shigomori/contracts/types";
import { lastUpdaterState, shellCalls } from "@host/process/shell";

// The updater lives in the shell (main/electron/updater.ts), which
// reports its state here as it moves (host/process/session.ts). A
// peer's Settings page reads it and, when granted, checks or restarts
// into an update through the shell.
export const updaterHandlers: Handlers<typeof updaterContract, HandlerContext> =
  {
    get: () => lastUpdaterState(),
    check: () => shellCalls().updater.check(),
    install: (_input, ctx) => shellCalls().updater.install(isRemoteCaller(ctx)),
    update: (_input, ctx) => shellCalls().updater.update(isRemoteCaller(ctx)),
  };
