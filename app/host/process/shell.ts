// The Shell service (lib/Shell.ts) over the shell's calls, which ride
// the port the shell handed over as the host started (host.ts).
import { callFailureOf } from "@shigomori/contracts/errors";
import type { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import type { Client } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Shell from "@host/lib/Shell";

const onShell = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: callFailureOf });

export const layer = (calls: Client<typeof shellCallsContract>) =>
  Layer.effect(
    Shell.Shell,
    Effect.map(Ref.make<UpdaterState>({ kind: "idle" }), (state) =>
      Shell.Shell.of({
        relaunch: Effect.sync(() => void calls.relaunch()),
        updater: {
          check: onShell(() => calls.updaterCheck()),
          install: (unattended) =>
            onShell(() => calls.updaterInstall({ unattended })),
          update: (unattended) =>
            onShell(() => calls.updaterUpdate({ unattended })),
          state: Ref.get(state),
          noteState: (next) => Ref.set(state, next),
        },
        stopUpdaterBridge: Effect.sync(() => void calls.stopUpdaterBridge()),
        migration: (progress) => onShell(() => calls.migration(progress)),
      }),
    ),
  );
