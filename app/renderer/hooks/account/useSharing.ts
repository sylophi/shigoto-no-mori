// This device's sharing switch (packages/contracts/src/modules/sharing.ts),
// for its account page: the host's view of it (sharing:watch), which
// moves whoever moved it (this window, another one, `sm config` in a
// terminal).
import { callOf } from "@shigomori/contracts/contract";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { useMutation } from "@tanstack/react-query";
import * as Atom from "effect/reactivity/Atom";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { useView } from "@/lib/runtime/viewHooks";

const sharingAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    view: callOf(sharingContract, "watch"),
    input: undefined,
  }),
);

export function useSharing() {
  const api = useApi();
  return useView(api.isElectron ? sharingAtom(api.deviceId) : null);
}

// The view follows the write, so this sets nothing itself.
export function useSetSharing() {
  const api = useApi();
  return useMutation<void, Error, boolean>({
    mutationFn: (on) => api.run(api.sharing.set(on)),
    meta: { errorTitle: "Couldn't change sharing" },
  });
}
