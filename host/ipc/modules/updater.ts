import { Context, Effect } from "effect";
import { updaterContract } from "@shared/ipc/modules/updater";
import { type HandlerContext, isRemoteCaller } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { UpdaterState } from "@shared/schemas";
import { hostAttempt, hostHandler, requireService } from "@host/runtime";

// The electron layer owns the updater wiring (the CLI-driven pipeline
// in main/electron/updater.ts) and provides the concrete state machine.
// Keeping it behind a service lets the handler module stay free of
// Electron imports, like every other host module.
type UpdaterImpl = {
  getState: () => UpdaterState;
  check: () => void;
  // `unattended` marks an install requested by another device: nobody
  // is at this machine to answer a native prompt, so a busy host must
  // refuse (the error rides back to the caller) instead of blocking
  // the call on a dialog no one will see.
  install: (unattended: boolean) => void | Promise<void>;
};

export class Updater extends Context.Service<Updater, UpdaterImpl>()(
  "sm/host/Updater",
) {}

const updater = requireService(
  Updater,
  "updater handler invoked before the host runtime provided Updater",
);

export const updaterHandlers: Handlers<typeof updaterContract, HandlerContext> =
  {
    get: hostHandler(() => Effect.map(updater, (impl) => impl.getState())),
    check: hostHandler(() =>
      Effect.flatMap(updater, (impl) =>
        hostAttempt(() => impl.check()).pipe(Effect.as(undefined)),
      ),
    ),
    install: hostHandler((_input: unknown, ctx: HandlerContext) =>
      Effect.flatMap(updater, (impl) =>
        hostAttempt(async () => {
          await impl.install(isRemoteCaller(ctx));
        }).pipe(Effect.as(undefined)),
      ),
    ),
  };
