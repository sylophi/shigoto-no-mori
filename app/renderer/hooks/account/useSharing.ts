// This device's sharing switch (packages/contracts/src/modules/sharing.ts),
// for its account page: the host's view of it (sharing:watch), which
// moves whoever moved it (this window, another one, `sm config` in a
// terminal).
import { callOf } from "@shigomori/contracts/contract";
import { sharingContract } from "@shigomori/contracts/modules/sharing";
import { useMutation } from "@tanstack/react-query";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useView } from "@/lib/runtime/viewHooks";

const sharingAtom = hostViewAtom({
  deviceId: localDeviceId,
  localDeviceId,
  view: callOf(sharingContract, "watch"),
  input: undefined,
});

export function useSharing() {
  return useView(hasLocalHost ? sharingAtom : null);
}

// The view follows the write, so this sets nothing itself.
export function useSetSharing() {
  return useMutation<void, Error, boolean>({
    mutationFn: (on) => window.api.sharing.set(on),
    meta: { errorTitle: "Couldn't change sharing" },
  });
}
