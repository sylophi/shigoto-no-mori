import { updaterContract } from "@shared/ipc/modules/updater/contract";
import type { Handlers } from "@shared/ipc/types";
import type { UpdaterState } from "@shared/schemas";

// The electron layer owns the autoUpdater wiring and injects the
// concrete state machine at boot. Keeping these as setters lets the
// handler module stay free of Electron imports.
type UpdaterImpl = {
  getState: () => UpdaterState;
  check: () => void;
  install: () => void;
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

export const updaterHandlers: Handlers<typeof updaterContract> = {
  get: () => impl.getState(),
  check: () => impl.check(),
  install: () => impl.install(),
};
