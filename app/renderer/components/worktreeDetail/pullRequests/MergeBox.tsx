import { MergeBoxView } from "./MergeBoxView";
import { useMergeBox } from "./useMergeBox";

// The merge box (MergeBoxView), with its mutations and picks.
export function MergeBox(props: Parameters<typeof useMergeBox>[0]) {
  return <MergeBoxView {...useMergeBox(props)} />;
}
