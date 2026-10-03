import { MergeBoxView } from "./MergeBoxView";
import { type UseMergeBoxArgs, useMergeBox } from "./useMergeBox";

// The merge box (MergeBoxView), with its mutations and picks.
export function MergeBox(props: UseMergeBoxArgs) {
  return <MergeBoxView {...useMergeBox(props)} />;
}
