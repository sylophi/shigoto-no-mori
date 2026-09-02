import { updaterContract } from "@shared/ipc/modules/updater";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { UpdaterState } from "@shared/schemas";

// The electron layer owns the updater wiring (the CLI-driven pipeline
// in main/electron/updater.ts) and injects the concrete state machine
// at boot. Keeping these as setters lets the handler module stay free
// of Electron imports, like every other host module.
type UpdaterImpl = {
  getState: () => UpdaterState;
  check: () => void;
  // `unattended` marks an install requested by another device: nobody
  // is at this machine to answer a native prompt, so a busy host must
  // refuse (the error rides back to the caller) instead of blocking
  // the call on a dialog no one will see.
  install: (unattended: boolean) => void | Promise<void>;
};

let impl: UpdaterImpl = {
  getState: () => ({ kind: "idle" }),
  check: () => {
    throw new Error("updater handler invoked before electron registered impl");
  },
  install: () => {
    throw new Error("updater handler invoked before electron registered impl");
  },
};

export function setUpdaterImpl(next: UpdaterImpl): void {
  impl = next;
}

export const updaterHandlers: Handlers<typeof updaterContract, HandlerContext> =
  {
    get: () => impl.getState(),
    check: () => impl.check(),
    // Only a wire that authenticated a peer supplies callerDeviceId, so
    // its presence is exactly "another device asked".
    install: (_input, ctx) => impl.install(ctx.callerDeviceId !== undefined),
  };
