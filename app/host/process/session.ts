// The host's side of its shell: what the shell tells it and asks of
// it, beside the window and terminal calls every process on the
// loopback makes. `startHost` wires the host before its graph comes up;
// `hostSession` is what the shell holds after.
import { updaterContract } from "@shigomori/contracts/modules/updater";
import type { UpdaterState } from "@shigomori/contracts/schemas";
import type { BusyOperations } from "@shared/busy";
import { setWindowFocused } from "@host/lib/git/backgroundFetch";
import { getBusyOperations } from "@host/lib/scripts";
import { loopback } from "@host/socket/loopback";
import type { AccountFacts } from "./account";
import { type HostFacts, setHostFacts } from "./facts";
import {
  applyAccount,
  noteAccountDevices,
  registerHostHandlers,
} from "./handlers";
import { installHostImpls } from "./impls";
import { noteUpdaterState, type ShellCalls, setShellCalls } from "./shell";
import { broadcastAll, probeRemoteConnections } from "./wires";

export type HostSession = {
  // The account's facts: at start, and after every change.
  readonly account: (facts: AccountFacts | null) => Promise<void>;
  // The account's registry, as the shell last read it from the hub.
  readonly accountDevices: (deviceIds: ReadonlyArray<string>) => Promise<void>;
  // A window here gained or lost focus.
  readonly windowFocused: (focused: boolean) => Promise<void>;
  // The machine woke: every remote socket is probed.
  readonly wake: () => Promise<void>;
  // What a quit would interrupt.
  readonly busy: () => Promise<BusyOperations>;
  // The updater moved.
  readonly updaterState: (state: UpdaterState) => Promise<void>;
  // Where the windows reach the host.
  readonly address: () => Promise<{ port: number; token: string }>;
};

export function startHost(facts: HostFacts, shell: ShellCalls): void {
  setHostFacts(facts);
  setShellCalls(shell);
  installHostImpls();
  registerHostHandlers();
}

export const hostSession: HostSession = {
  account: applyAccount,
  accountDevices: async (deviceIds) => noteAccountDevices(deviceIds),
  windowFocused: async (focused) => setWindowFocused(focused),
  wake: async () => probeRemoteConnections(),
  busy: async () => getBusyOperations(),
  updaterState: async (state) => {
    noteUpdaterState(state);
    broadcastAll(updaterContract, "state", state);
  },
  address: () => loopback.address(),
};
