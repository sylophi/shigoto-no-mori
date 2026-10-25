import { useAtomValue } from "@effect/atom-react";
import { callOf } from "@shigomori/contracts/contract";
import { gitContract } from "@shigomori/contracts/modules/git";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Stream from "effect/Stream";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  accountsLeftAtom,
  clientAtoms,
  hostPushes,
  localDeviceIdAtom,
  hostSessionAtom,
} from "@/lib/runtime/atoms";

const NONE: ReadonlySet<string> = new Set();

// Which of a device's projects are fetching refs right now, off its
// git:fetchActive pushes, read by the worktree page under that device's
// scope. The boot mounts this machine's where it has a host, and a
// peer's from the moment its session lands (boot.tsx), so a fetch that
// starts while no page shows reads as fetching when one opens. It
// starts over on each new session to the device's host, since a fetch
// that ended while its session was down, or with its host, never says
// so, and a peer's with the account.
export const gitFetchingAtom = Atom.family((deviceId: string) =>
  Atom.keepAlive(
    clientAtoms.atom(
      (get) => {
        const localDeviceId = get(localDeviceIdAtom);
        get(hostSessionAtom(deviceId));
        if (deviceId !== localDeviceId) get(accountsLeftAtom);
        return hostPushes(
          deviceId,
          localDeviceId,
          callOf(gitContract, "fetchActive"),
        ).pipe(
          Stream.scan(
            (): ReadonlySet<string> => NONE,
            (active, { projectId, active: fetching }) => {
              if (fetching === active.has(projectId)) return active;
              const next = new Set(active);
              if (fetching) next.add(projectId);
              else next.delete(projectId);
              return next;
            },
          ),
        );
      },
      { initialValue: NONE },
    ),
  ),
);

export function useProjectGitFetching(projectId: string): boolean {
  const { deviceId } = useHostScope();
  return useAtomValue(
    gitFetchingAtom(deviceId),
    (result) => AsyncResult.isSuccess(result) && result.value.has(projectId),
  );
}
