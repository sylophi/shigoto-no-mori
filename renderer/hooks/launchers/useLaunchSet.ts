import { useMutation } from "@tanstack/react-query";
import {
  runLaunchSet,
  type LaunchSetInput,
  type LaunchSetResult,
} from "@/lib/launchSet";

// Pending state for the set pill. runLaunchSet resolves even when every
// member failed -- it owns the single summary toast -- so there's no
// errorTitle here and onError can't fire.
export function useLaunchSet() {
  // react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation -- by design: matches useLaunch, whose bumpUseCount must not reshuffle the pinned row order mid-interaction
  return useMutation<LaunchSetResult, Error, LaunchSetInput>({
    mutationFn: (input) => runLaunchSet(input),
  });
}
