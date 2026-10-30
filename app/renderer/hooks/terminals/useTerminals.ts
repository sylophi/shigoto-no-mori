import { callOf } from "@shigomori/contracts/contract";
import { terminalsContract } from "@shigomori/contracts/modules/terminals";
import type { Terminal } from "@shigomori/contracts/schemas";
import type { TerminalMark } from "@shigomori/ui/views/sidebar/TerminalMarkView.tsx";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import { hostViewAtom, noView } from "@/lib/runtime/atoms";
import { useView } from "@/lib/runtime/viewHooks";

// A device's open terminals, as its host streams them (terminals:list):
// a worktree page's drawer, and the Live page's.
export const terminalsAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    view: callOf(terminalsContract, "list"),
    input: undefined,
  }),
);

// The scoped device's open terminals. Null until the first answer, and
// while the device gives none (a peer that runs no commands from here,
// asked again as atoms.ts paces a refusal).
export function useTerminals(): readonly Terminal[] | null {
  const { deviceId, hasHost } = useHostScope();
  return (
    useView(hasHost ? terminalsAtom(deviceId) : null).data?.terminals ?? null
  );
}

// The sidebar's terminal mark for a worktree: "busy" while a command
// holds one of its shells, "open" while any is open, read through the
// row's api (useRowHostApi). Only a row whose mark changes renders again.
export function useWorktreeTerminalMark(
  worktreeId: string,
  deviceId: string,
  api: HostApi | undefined,
): TerminalMark | null {
  const view = api === undefined ? noView : terminalsAtom(deviceId);
  return useAtomValue(view, (result) => {
    const terminals = AsyncResult.getOrElse(
      result,
      () => undefined,
    )?.terminals.filter((terminal) => terminal.worktreeId === worktreeId);
    if (terminals === undefined || terminals.length === 0) return null;
    return terminals.some((terminal) => terminal.busy) ? "busy" : "open";
  });
}
