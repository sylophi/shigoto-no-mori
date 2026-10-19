// The Shell service (lib/Shell.ts) over the shell's calls, which ride
// the port the shell handed over as the host started (host.ts).
import { callFailureOf } from "@shigomori/contracts/errors";
import type { shellCallsContract } from "@shigomori/contracts/modules/shellCalls";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import type { EffectClient } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Shell from "@host/lib/Shell";

const ask = <A>(call: Effect.Effect<A, unknown>) =>
  Effect.mapError(call, callFailureOf);

export const layer = (calls: EffectClient<typeof shellCallsContract>) =>
  Layer.effect(
    Shell.Shell,
    Effect.gen(function* () {
      const state = yield* Ref.make<UpdaterState>({ kind: "idle" });
      // What is asked without waiting, run for as long as the layer is.
      const runFork = yield* FiberSet.makeRuntime<never>();
      const tell = (call: Effect.Effect<void, unknown>) =>
        Effect.sync(() => void runFork(Effect.ignore(call)));
      return Shell.Shell.of({
        relaunch: tell(calls.relaunch()),
        moveFailed: (reason) => tell(calls.moveFailed({ reason })),
        updater: {
          check: ask(calls.updaterCheck()),
          install: (unattended) => ask(calls.updaterInstall({ unattended })),
          update: (unattended) => ask(calls.updaterUpdate({ unattended })),
          state: Ref.get(state),
          noteState: (next) => Ref.set(state, next),
        },
        holdUpdater: (forWhat) =>
          calls
            .holdUpdater({ for: forWhat })
            .pipe(Effect.orElseSucceed(() => null)),
        resumeUpdater: Effect.ignore(calls.resumeUpdater()),
        stopUpdaterBridge: Effect.ignore(calls.stopUpdaterBridge()),
        migration: (progress) => ask(calls.migration(progress)),
        guide: (payload) => ask(calls.guide(payload)),
      });
    }),
  );
