import { callOf } from "@shigomori/contracts/contract";
import { terminalsContract } from "@shigomori/contracts/modules/terminals";
import type { Terminal } from "@shigomori/contracts/schemas";
import * as Atom from "effect/reactivity/Atom";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { localDeviceId } from "@/lib/queryKeys";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useView } from "@/lib/runtime/viewHooks";

// A device's open terminals, as its host streams them (terminals:list).
const terminalsAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    localDeviceId,
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
