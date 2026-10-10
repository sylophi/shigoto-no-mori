// Wires the host up as it starts, ahead of its graph: its facts, the
// calls it makes back to its shell, the handlers on its wires, and the
// shell's session (packages/contracts/src/modules/session.ts) on the
// loopback.
import { sessionContract } from "@shigomori/contracts/modules/session";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { getBusyOperations } from "@host/lib/scripts";
import { busyTerminals, setWindowFocused } from "./captures";
import { type HostFacts, setHostFacts } from "./facts";
import {
  applyAccount,
  noteAccountDevices,
  registerHostHandlers,
} from "./handlers";
import { installHostImpls } from "./impls";
import { noteUpdaterState, type ShellCalls, setShellCalls } from "./shell";
import {
  broadcastAll,
  probeRemoteConnections,
  registerLoopbackContract,
} from "./wires";

// The root's own Promise work, for the session's calls.
const onRoot = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: callFailureOf });

export function startHost(options: {
  readonly facts: HostFacts;
  readonly shell: ShellCalls;
  // The shell asked the host to stop. `hurried` is an update install or
  // a relaunch, which signals scripts instead of waiting them out.
  readonly quit: (hurried: boolean) => void;
}): void {
  setHostFacts(options.facts);
  setShellCalls(options.shell);
  installHostImpls();
  registerHostHandlers();
  const session: EffectHandlers<typeof sessionContract, HandlerContext> = {
    account: (facts) => onRoot(() => applyAccount(facts)),
    accountDevices: (deviceIds) =>
      Effect.sync(() => noteAccountDevices(deviceIds)),
    windowFocused: (focused) => Effect.sync(() => setWindowFocused(focused)),
    wake: () => Effect.sync(probeRemoteConnections),
    busy: () =>
      Effect.map(onRoot(busyTerminals), (terminals) => ({
        ...getBusyOperations(),
        busyTerminals: terminals,
      })),
    updaterState: (state) =>
      Effect.sync(() => {
        noteUpdaterState(state);
        broadcastAll(updaterContract, "state", state);
      }),
    quit: ({ hurried }) => Effect.sync(() => options.quit(hurried)),
  };
  registerLoopbackContract(sessionContract, session);
}
