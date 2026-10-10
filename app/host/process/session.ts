// Wires the host up as it starts, ahead of its graph: its facts, the
// calls it makes back to its shell, the handlers on its wires, and the
// shell's session (packages/contracts/src/modules/session.ts) on the
// loopback.
import { sessionContract } from "@shigomori/contracts/modules/session";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { updaterContract } from "@shigomori/contracts/modules/updater";
import { setWindowFocused } from "@host/lib/git/backgroundFetch";
import { getBusyOperations } from "@host/lib/scripts";
import { busyTerminals } from "./captures";
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
  const session: Handlers<typeof sessionContract, HandlerContext> = {
    account: (facts) => applyAccount(facts),
    accountDevices: (deviceIds) => noteAccountDevices(deviceIds),
    windowFocused: (focused) => setWindowFocused(focused),
    wake: () => probeRemoteConnections(),
    busy: async () => ({
      ...getBusyOperations(),
      busyTerminals: await busyTerminals(),
    }),
    updaterState: (state) => {
      noteUpdaterState(state);
      broadcastAll(updaterContract, "state", state);
    },
    quit: ({ hurried }) => options.quit(hurried),
  };
  registerLoopbackContract(sessionContract, session);
}
